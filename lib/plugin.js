"use strict";

var colors = require('colors/safe');
var util = require('babel-core/lib/util');

function log(message) {
	// use console.error as stdout seems swallowed
	console.error(colors.gray("[STREAMLINE-PLUGIN] " + message));
}

function warn(message) {
	// use console.error as stdout seems swallowed
	console.error(colors.yellow("[STREAMLINE-PLUGIN] " + message));
}

function error(message) {
	return new Error(colors.magenta("[STREAMLINE-PLUGIN] " + message));
}

function is_(node) {
	return node.type === 'Identifier' && node.name === '_' && !node.$done;
}

function isTilde_(node) {
	return node.type === 'UnaryExpression' && node.operator === '~' && is_(node.argument);
}

function isCallbackArg(node) {
	return is_(node) || isTilde_(node);
}

function isFutureArg(node) {
	return node.type === 'UnaryExpression' && node.operator === '!' && is_(node.argument);
}

function isRShift_(node) {
	return node.type === 'BinaryExpression' && node.operator === '>>' && is_(node.left);
}

function isArray_(node) {
	return node.type === 'ArrayExpression' && node.elements.length === 1 && is_(node.elements[0]);
}

function findIndex(array, pred) {
	for (var i = 0; i < array.length; i++)
		if (pred(array[i])) return i;
	return -1;
}

var runtimes = {
	await: {
		name: 'await',
		generator: false,
		async: true,
	},
	fibers: {
		name: 'fibers',
		generator: false,
		async: false,
	},
	galaxy: {
		name: 'galaxy',
		generator: true,
		async: false,
	}
}

function makeTemplate(name, code) {
	util.templates["streamline-" + name] = util.parseTemplate(__filename, code);
}
function applyTemplate(name, nodes) {
	return util.template("streamline-" + name, nodes)
}

function runtimeCall(t, state, name, args) {
	return t.CallExpression(
		t.memberExpression(
			t.identifier(state.runtimeVar), 
			t.identifier(name)
		),
		args
	)
}
makeTemplate('call-wrapper', '$runtime$.$method$($object$, $property$, $index$)($args$)');

function streamlineCall(t, state, node, method, index) {
	var callee = node.callee;
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? 
		(callee.computed ? callee.property : t.literal(callee.property.name)) : callee;

	return applyTemplate('call-wrapper', {
		$runtime$: t.identifier(state.runtimeVar),
		$method$: t.identifier(method),
		$object$: object,
		$property$: property,
		$index$: t.literal(index),
		$args$: node.arguments,
	});
}

function awaitWrap(t, state, expression) {
	var rt = state.runtime;
	if (rt.async) return t.awaitExpression(expression);
	else if (rt.generator) return t.yieldExpression(expression);
	else return expression;
}

function awaitCall(t, state, node, index) {
	return awaitWrap(t, state, streamlineCall(t, state, node, 'await', index));
}

function future(t, state, node, index) {
	return streamlineCall(t, state, node, 'future', index);
}

makeTemplate('function-wrapper', 
	'function $id$($params1$) {' +
	'	return $runtime$.async(function $id_$($params2$) { $body$ }, $index$).apply(this, arguments);' +
	'}');

function streamlineFunction(t, state, node, index) {
	var params = node.params.slice();
	var rt = state.runtime;

	var outerFunc = applyTemplate('function-wrapper', {
		$id$: node.id ? node.id : t.identifier('anon'),
		$params1$: params,
		$runtime$: t.identifier(state.runtimeVar),
		$id_$: t.identifier(node.id ? node.id.name + '_' : 'anon_'),
		$params2$: params,
		$body$: node.body,
		$index$: t.literal(index),
	});
	var innerFunc = outerFunc.body.body[0].argument.callee.object.arguments[0];
	innerFunc.generator = rt.generator;
	innerFunc.async = rt.async;
	innerFunc.isStreamline = true;
	outerFunc.type = node.type;
	return outerFunc;
}

function streamlineNew(t, state, node, index) {
	return t.callExpression(
		runtimeCall(t, state, 'new', [node.callee, t.literal(index)]),
		node.arguments
	);
}

makeTemplate("require-var", "var $name = require($path);");

function runtimePrologue(t, state) {
	var prologue = [applyTemplate("require-var", {
		$name: t.identifier(state.runtimeVar),
		$path: t.literal('streamline-runtime/lib/runtime-' + state.runtime.name),
	})];
	if (state.runtime.async || state.runtime.generator || state.needsRegenerator) {
		prologue.push(applyTemplate("require-var", {
			$name: t.identifier('regeneratorRuntime'),
			$path: t.literal('regenerator-runtime-only'),
		}));
	}
	return prologue;
}

makeTemplate("program-wrapper", "$runtime$.async(function() { $body$ }, 0)(function(err) { if (err) throw err; })");

function asyncProgramWrapper(t, state, node) {
	var wrapper = applyTemplate("program-wrapper", {
		$runtime$: t.identifier(state.runtimeVar),
		$body$: node.body,
	});
	var func = wrapper.callee.arguments[0];
	func.generator = state.runtime.generator;
	func.async = state.runtime.async;
	return wrapper;
}

function canTransform(state) {
	return !(state.opts.filename && !/\._js$/.test(state.opts.filename))
}

function verbose(state) {
	var st = state.opts.extra.streamline;
	return st && st.verbose;
}

module.exports = function(pluginArguments) {
	var Plugin = pluginArguments.Plugin;
	var t = pluginArguments.types;
	return new Plugin("streamline", {
		visitor: {
			Identifier: {
				exit: function(node, parent, scope, state) {
					if (!canTransform(state)) return;
					if (is_(node) && !node.done) {
						throw state.errorWithNode(node, "unexpected _");
					}
				}
			},
			Program: {
				enter: function(node, parent, scope, state) {
					if (!state.opts.extra.streamline) state.opts.extra.streamline = {
						verbose: true, // to get diagnose
					}
					var st = state.opts.extra.streamline;
					if (!st.runtime) {
						warn("streamline runtime not configured. Defaulting to galaxy");
						st.runtime = "galaxy";
					}
					state.runtime = runtimes[st.runtime];
					if (!state.runtime) throw new Error("invalid runtime configuration: " + st.runtime);

					if (verbose(state)) log("transforming " + state.opts.filename);
					state.runtimeVar = scope.generateUid('streamline');
				},
				exit: function(node, parent, scope, state) {
					if (!canTransform(state) && !state.needsRegenerator) return;
					return t.program(runtimePrologue(t, state).concat(state.programIsAsync ? asyncProgramWrapper(t, state, node) : node.body));
				}
			},
			Function: function(node, parent, scope, state) {
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				if (node.async || node.generator) state.needsRegenerator = true;
				if (!canTransform(state)) return;
				var index;
				if ((index = findIndex(node.params, is_)) >= 0) {
					var param = node.params[index];
					param.$done = true;
					if (node.generator) throw state.errorWithNode(param, "parameter _ not allowed in generator function");
					if (node.async) throw state.errorWithNode(param, "parameter _ not allowed: function already marked `async`");
					return streamlineFunction(t, state, node, index);

				}
			},
			CallExpression: function(node, parent, scope, state) {
				if (!canTransform(state)) return;
				var callee = node.callee;
				var index;
				if ((index = findIndex(node.arguments, isCallbackArg)) >= 0) {
					var funcScope = scope.getFunctionParent();
					if (!funcScope.parent) {
						warn(state.errorWithNode(node.arguments[index], "warning: async call at top level").message);
						state.programIsAsync = true;
					} else {
						if (!funcScope.block.isStreamline) throw state.errorWithNode(node, "unexpected `_` argument: enclosing function does not have an `_` parameter.");
					}
					node.arguments[index] = t.literal(true);
					return awaitCall(t, state, node, index);
				}
				if ((index = findIndex(node.arguments, isFutureArg)) >= 0) {
					node.arguments[index] = t.literal(false);
					return future(t, state, node, index);
				}
				if ((index = findIndex(node.arguments, isRShift_)) >= 0) {
					node.arguments[index] = node.arguments[index].right;
					return node;
				}
				if ((index = findIndex(node.arguments, isArray_)) >= 0) {
					node.arguments[index] = t.literal(true);
					warn("NIY: array call");
					return  awaitCall(t, state, node, index);
				}
				if (is_(callee) && node.arguments.length === 2) {
					return node.arguments[0];
				}
			},
			NewExpression: function(node, parent, scope, state) {
				if (!canTransform(state)) return;
				var index;
				if ((index = findIndex(node.arguments, is_)) >= 0) {
					node.arguments[index] = t.literal(true);
					return awaitWrap(t, state, streamlineNew(t, state, node, index));
				}
			},
			"YieldExpression|AwaitExpression": function(node, parent, scope, state) {
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				state.needsRegenerator = true;
			},
		}
	});
}
