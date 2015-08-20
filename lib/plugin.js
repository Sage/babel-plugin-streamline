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

function isPromiseArg(node) {
	return node.type === 'UnaryExpression' && node.operator === 'void' && is_(node.argument);
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
	t.identifier(state.runtimeVar), t.identifier(name)), args)
}
makeTemplate('call-wrapper', '$runtime$.$method$($object$, $property$, $index1$, $index2$, $returnArray$)($args$)');

function streamlineCall(t, state, node, method, index1, index2, returnArray) {
	var callee = node.callee;
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? (callee.computed ? callee.property : t.literal(callee.property.name)) : callee;

	return applyTemplate('call-wrapper', {
		$runtime$: t.identifier(state.runtimeVar),
		$method$: t.identifier(method),
		$object$: object,
		$property$: property,
		$index1$: t.literal(index1),
		$index2$: t.literal(index2),
		$returnArray$: t.literal(returnArray),
		$args$: node.arguments,
	});
}

function awaitWrap(t, state, expression) {
	var rt = state.runtime;
	if (rt.async) return t.awaitExpression(expression);
	else if (rt.generator) return t.yieldExpression(expression);
	else return expression;
}

function awaitCall(t, state, node, index1, index2, returnArray) {
	return awaitWrap(t, state, streamlineCall(t, state, node, 'await', index1, index2, returnArray));
}

function future(t, state, node, index) {
	return streamlineCall(t, state, node, 'future', index, null, false);
}

makeTemplate('function-wrapper-inner', '$runtime$.async(function $id_$($params$) { $body$ }, $index$)');
makeTemplate('function-wrapper-outer', 'function $id$($params$) { return $inner$.apply(this, arguments); }');

function streamlineFunction(t, state, node, scope, index) {
	var params = node.params;
	var rt = state.runtime;

	var innerCall = applyTemplate('function-wrapper-inner', {
		$runtime$: t.identifier(state.runtimeVar),
		$id_$: t.identifier(scope.generateUid(node.id ? node.id.name : '')),
		$params$: params.slice(),
		$body$: node.body.body,
		$index$: t.literal(index),
	});
	var innerFunc = innerCall.arguments[0];
	innerFunc.generator = rt.generator;
	innerFunc.async = rt.async;
	innerFunc.isStreamline = true;
	return innerCall;
}

function streamlineNew(t, state, node, index) {
	return t.callExpression(
	runtimeCall(t, state, 'new', [node.callee, t.literal(index)]), node.arguments);
}

makeTemplate("require-var", "var $name = require($path);");

function runtimePrologue(t, state) {
	var prologue = [];
	if (state.runtime.async || state.runtime.generator || state.needsRegenerator) {
		prologue.push(applyTemplate("require-var", {
			$name: t.identifier('regeneratorRuntime'),
			$path: t.literal('regenerator/runtime'),
		}));
	}
	if (canTransform(state)) {
		prologue.push(applyTemplate("require-var", {
			$name: t.identifier(state.runtimeVar),
			$path: t.literal('streamline-runtime/lib/runtime-' + state.runtime.name),
		}));
		if (!/\/streamline\/lib\/util\/builtins/.test(state.opts.filename)) {
			prologue.push(t.expressionStatement(t.callExpression(t.identifier('require'), [t.literal("streamline/lib/util/builtins")])));
		}
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

makeTemplate("iife-apply", "(function(_) { $body$ }).apply_(_, this, arguments, 0)");
makeTemplate("const-decl", "var $name$ = $value$;");


function hoist(t, nodes) {
	var hoisted = nodes.filter(function(node) {
		return t.isFunctionDeclaration(node);
	}).map(function(node) {
		return applyTemplate('const-decl', {
			$name$: t.identifier(node.id.name),
			$value$: t.functionExpression(t.identifier(node.id.name), node.params, node.body, node.generator, node.async),
		})
	});
	var other = nodes.filter(function(node) {
		return !t.isFunctionDeclaration(node);
	});
	return hoisted.concat(other);
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
						verbose: true,
						// to get diagnose
					}
					var st = state.opts.extra.streamline;
					if (!st.runtime) {
						warn("streamline runtime not configured. Defaulting to galaxy");
						st.runtime = "galaxy";
					}
					state.runtime = runtimes[st.runtime];
					if (!state.runtime) throw new Error("invalid runtime configuration: " + st.runtime);

					if (verbose(state)) log("transforming " + state.opts.filename + ' (' + st.runtime + ')');
					state.runtimeVar = scope.generateUid('streamline');
					return t.program(hoist(t, node.body));
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
				if (t.isFunctionDeclaration(node)) throw state.errorWithNode(node, "nested function declaration");
				var index;
				if ((index = findIndex(node.params, is_)) >= 0) {
					var param = node.params[index];
					param.$done = true;
					if (node.generator) throw state.errorWithNode(param, "parameter _ not allowed in generator function");
					if (node.async) throw state.errorWithNode(param, "parameter _ not allowed: function already marked `async`");
					return streamlineFunction.call(this, t, state, node, scope, index);

				}

			},
			CallExpression: function(node, parent, scope, state) {
				if (!canTransform(state)) return;
				var callee = node.callee;
				var index1;
				var funcScope = scope.getFunctionParent();
				if ((index1 = findIndex(node.arguments, isCallbackArg)) >= 0) {
					if (!funcScope.parent) {
						warn(state.errorWithNode(node.arguments[index1], "warning: async call at top level").message);
						state.programIsAsync = true;
					} else {
						if (!funcScope.block.isStreamline) throw state.errorWithNode(node, "unexpected `_` argument: enclosing function does not have an `_` parameter.");
					}
					node.arguments[index1] = t.literal(true);
					var index2 = findIndex(node.arguments, is_);
					if (index2 >= 0) {
						node.arguments[index2] = t.literal(true);
						if (findIndex(node.arguments, is_) >= 0) throw state.errorWithNode(node, "async call cannot have more than 2 _ arguments");
						return awaitCall(t, state, node, index1, index2, false);
					}
					return awaitCall(t, state, node, index1, null, false);
				}
				if ((index1 = findIndex(node.arguments, isFutureArg)) >= 0) {
					node.arguments[index1] = t.literal(false);
					return future(t, state, node, index1);
				}
				if ((index1 = findIndex(node.arguments, isPromiseArg)) >= 0) {
					node.arguments[index1] = t.literal(false);
					return t.memberExpression(future(t, state, node, index1), t.identifier('promise'));
				}
				if ((index1 = findIndex(node.arguments, isRShift_)) >= 0) {
					node.arguments[index1] = node.arguments[index1].right;
					return node;
				}
				if ((index1 = findIndex(node.arguments, isArray_)) >= 0) {
					node.arguments[index1] = t.literal(true);
					return awaitCall(t, state, node, index1, null, true);
				}
				if (is_(callee) && node.arguments.length === 2) {
					return node.arguments[0];
				}
				if (funcScope.block.isStreamline) {
					// handle CoffeeScript IIFE 
					var innerFunc;
					if (t.isFunctionExpression(callee) && callee.params.length === 0 && node.arguments.length === 0) {
						// (function() { ... })() ->  (await (async function() { ... })())
						innerFunc = callee;
					} else if (t.isMemberExpression(callee) && t.isFunctionExpression(callee.object) && callee.object.params.length === 0) {
						if (callee.property.name === 'call' && node.arguments.length === 1 && t.isThisExpression(node.arguments[0])) {
							// (function() { ... }).call(this) ->  (await (async function(_) { ... }).call(this, _)
							innerFunc = callee.object;
						} else if (callee.property.name === 'apply' && node.arguments.length === 2 && t.isThisExpression(node.arguments[0]) && node.arguments[1].name === 'arguments') {
							// (function() { ... }).apply(this, arguments) ->  (await (async function() { ... }).apply(this, arguments))
							innerFunc = callee.object;
						}
					}
					if (innerFunc && !innerFunc.isStreamline) {
						// this is a CS IIFE - (and we are not recursing)
						innerFunc.isStreamline = true;
						if (state.runtime.async) {
							innerFunc.async = true;
							return t.awaitExpression(node);
						} else if (state.runtime.generator) {
							innerFunc.generator = true;
							return t.yieldExpression(node);
						} else {
							return node;
						}
					}
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
			BlockStatement: function(node, parent, scope, state) {
				return t.blockStatement(hoist(t, node.body));
			},
		}
	});
}