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

function assert(cond) {
	if (!cond) throw error("assertion failed");
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
	callbacks: {
		name: 'callbacks',
		generator: true,
		regenerator: true,
		async: false,
	},
	fibers: {
		name: 'fibers',
		generator: false,
		async: false,
	},
	generators: {
		name: 'generators',
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
	t.identifier(state.streamline.runtimeVar), t.identifier(name)), args)
}
makeTemplate('call-wrapper', '$runtime$.$method$($file$, $line$, $object$, $property$, $index1$, $index2$, $returnArray$)');

function streamlineCall(t, scope, state, node, method, index1, index2, returnArray) {
	var callee = node.callee;
	var object, property;
	if (t.isMemberExpression(callee)) {
		object = callee.object;
		property = callee.computed ? callee.property : t.literal(callee.property.name);
	} else {
		/* enable this later
		var binding = scope.getBinding(callee.name);
		if (binding && binding.identifier.isStreamlineId && method === 'await' && index2 == null && !returnArray) {
			return t.callExpression(t.memberExpression(callee, t.literal('awaitWrapper-' + index1), true), node.arguments);
		}
		*/
		object = t.literal(null);
		property = callee;
	}

	var fn = applyTemplate('call-wrapper', {
		$runtime$: t.identifier(state.streamline.runtimeVar),
		$method$: t.identifier(method),
		$file$: t.identifier(state.streamline.filenameVar),
		$line$: t.literal(node.loc && node.loc.start.line),
		$object$: object,
		$property$: property,
		$index1$: t.literal(index1),
		$index2$: t.literal(index2),
		$returnArray$: t.literal(returnArray),
	});
	return t.callExpression(fn, node.arguments);
}

function awaitWrap(t, state, expression) {
	var rt = state.streamline.runtime;
	if (rt.async) return t.awaitExpression(expression);
	else if (rt.generator) return t.yieldExpression(expression);
	else return expression;
}

function awaitCall(t, scope, state, node, index1, index2, returnArray) {
	return awaitWrap(t, state, streamlineCall(t, scope, state, node, 'await', index1, index2, returnArray));
}

function futureCall(t, scope, state, node, index) {
	return streamlineCall(t, scope, state, node, 'future', index, null, false);
}

makeTemplate('function-wrapper', '$runtime$.async(function $id_$($params$) { $body$ }, $index$, $arity$)');

function guessName(t, parent) {
	if (t.isVariableDeclarator(parent)) {
		return parent.id.name;
	}
	if (t.isProperty(parent)) {
		if (t.isIdentifier(parent.key)) return parent.key.name;
		if (t.isLiteral(parent.key)) return '' + parent.key.value;
	}
	return "";
}

function streamlineFunction(t, state, node, scope, index) {
	var params = node.params;
	var rt = state.streamline.runtime;

	var body = node.type === 'ArrowFunctionExpression' && !t.isStatement(node.body) ? t.returnStatement(node.body) : node.body;
	var innerCall = applyTemplate('function-wrapper', {
		$runtime$: t.identifier(state.streamline.runtimeVar),
		$id_$: t.identifier(scope.generateUid(wrapName(node.id ? node.id.name : guessName(t, this.parent)))),
		$params$: params.slice(),
		$body$: body,
		$index$: t.literal(index),
		$arity$: t.literal(params.length),
	});
	var innerFunc = innerCall.arguments[0];
	if (node.type === 'ArrowFunctionExpression') innerFunc.type = node.type;
	innerFunc.generator = rt.generator;
	innerFunc.async = rt.async;
	innerFunc.isStreamline = true;
	return innerCall;
}

function streamlineNew(t, state, node, index) {
	return t.callExpression(
	runtimeCall(t, state, 'new', [
		t.identifier(state.streamline.filenameVar),
		t.literal(node.loc && node.loc.start.line), 
		node.callee, 
		t.literal(index)]), node.arguments);
}

makeTemplate("require-var", "var $name = typeof require === 'function' ? require($path) : Streamline.require($path);");
makeTemplate("require", "typeof require === 'function' ? require($path) : Streamline.require($path)");

function runtimePrologue(t, state) {
	var prologue = [];
	if (state.streamline.runtime.regenerator && state.streamline.hasGenerator) {
		prologue.push(applyTemplate("require-var", {
			$name: t.identifier('regeneratorRuntime'),
			$path: t.literal('streamline-runtime/lib/callbacks/regenerator'),
		}));
	}
	if (canTransform(state)) {
		prologue.push(applyTemplate("require-var", {
			$name: t.identifier(state.streamline.runtimeVar),
			$path: t.literal('streamline-runtime/lib/' + state.streamline.runtime.name + '/runtime'),
		}));
		prologue.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(state.streamline.filenameVar), t.literal(state.opts.filename))]))
	}
	return prologue;
}

makeTemplate("program-wrapper", "$runtime$.async($arg$, 0, 1).call(this, function(err) { if (err) throw err; })");

function asyncProgramWrapper(t, state, node, scope) {
	var wrapper = t.functionExpression(t.identifier(scope.generateUid('')), [], //
		t.blockStatement(node.body), //
		state.streamline.runtime.generator, //
		state.streamline.runtime.async);

	return applyTemplate("program-wrapper", {
		$runtime$: t.identifier(state.streamline.runtimeVar),
		$arg$: wrapper,
	});
}

function canTransform(state) {
	return state.streamline.forceTransform || /^(unknown|.*\._(js|coffee))$/.test(state.opts.filename);
}

function quiet(state) {
	var st = state.opts.extra.streamline;
	return st && st.quiet;
}

function wrapName(name) {
	return /\$\$/.test(name) ? name : "$$" + name + "$$";
}

makeTemplate("var-decl", "var $name$ = $value$;");

function hoist(t, scope, nodes) {
	// Brute force hoisting by moving function bodies to top of enclosing functions
	var hoisted = nodes.filter(function(node) {
		return t.isFunctionDeclaration(node);
	}).map(function(node) {
		return applyTemplate('var-decl', {
			$name$: t.identifier(node.id.name),
			$value$: t.functionExpression(t.identifier(node.id.name), node.params, node.body, node.generator, node.async),
		})
	});
	var other = nodes.filter(function(node) {
		return !t.isFunctionDeclaration(node);
	});
	return hoisted.concat(other);
}

function likeThis(t, node) {
	return t.isThisExpression(node) || (t.isIdentifier(node) && node.name === '_this');
}

function unwrapIIFE(t, node) {
	var callee = node.callee;
	if (t.isFunctionExpression(callee) && callee.params.length === 0 && node.arguments.length === 0) {
		// (function() { ... })() ->  (await (async function() { ... })())
		return callee;
	} else if (t.isMemberExpression(callee) && t.isFunctionExpression(callee.object) && callee.object.params.length === 0) {
		if (callee.property.name === 'call' && node.arguments.length === 1 && likeThis(t, node.arguments[0])) {
			// (function() { ... }).call(this) ->  (await (async function(_) { ... }).call(this, _)
			return callee.object;
		} else if (callee.property.name === 'apply' && node.arguments.length === 2 && likeThis(t, node.arguments[0]) && node.arguments[1].name === 'arguments') {
			// (function() { ... }).apply(this, arguments) ->  (await (async function() { ... }).apply(this, arguments))
			return callee.object;
		}
	}
	return null;
}

function checkProgramAsync(t, node, parent, scope, state) {
	scope.traverse(node, {
		CallExpression: function(node, parent, scope, state) {
			var index = findIndex(node.arguments, isCallbackArg);
			if (index >= 0) {
				if (!state.streamline.programIsAsync) {
					state.streamline.programIsAsync = true;
					if (!quiet(state)) warn(state.errorWithNode(node, "warning: async call at top level").message);					
				}
			} else {
				var innerFunc = unwrapIIFE(t, node);
				if (innerFunc) innerFunc.isIIFE = true;
			}
		},
		Function: function(node, parent, scope, state) {
			if (!node.isIIFE) this.skip();
		},
	}, state);
	return state.streamline.programIsAsync;
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
					if (!state.opts.extra.streamline) state.opts.extra.streamline = {}
					var st = state.opts.extra.streamline;
					if (!st.runtime) {
						if (!quiet(state)) warn("streamline runtime not configured. Defaulting to callbacks");
						st.runtime = "callbacks";
					}
					state.streamline = {
						forceTransform: st.forceTransform,
						runtime: runtimes[st.runtime],
						fastLocs: [],
					};
					if (!state.streamline.runtime) throw new Error("invalid runtime configuration: " + st.runtime);

					//if (!quiet(state)) log("transforming " + state.opts.filename + ' (' + st.runtime + ')');
					state.streamline.runtimeVar = scope.generateUid('streamline');
					state.streamline.filenameVar = scope.generateUid('filename');
					node = t.program(hoist(t, scope, node.body));
					node.isStreamline = checkProgramAsync(t, node, parent, scope, state);
					return node;
				},
				exit: function(node, parent, scope, state) {
					if (!canTransform(state) && !state.streamline.hasGenerator) return;
					if (state.streamline.fastLocs.length > 0) {
						if (!quiet(state)) warn(state.opts.filename + ": " + "obsolete fast syntax detected at lines " + state.streamline.fastLocs.map(function(loc) {
							return loc ? loc.start.line : '?';
						}).join(','));
					}
					return t.program(runtimePrologue(t, state).concat(state.streamline.programIsAsync ? asyncProgramWrapper(t, state, node, scope) : node.body));
				}
			},
			Function: function(node, parent, scope, state) {
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				if (node.async || node.generator) state.streamline.hasGenerator = true;
				if (!canTransform(state)) return;
				var index;
				if ((index = findIndex(node.params, is_)) >= 0) {
					if (t.isFunctionDeclaration(node) && node.loc) throw state.errorWithNode(node, "nested function declaration");
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
					if (isTilde_(node.arguments[index1])) state.streamline.fastLocs.push(node.arguments[index1].loc);
					if (!funcScope.block.isStreamline) throw state.errorWithNode(node, "unexpected `_` argument: enclosing function does not have an `_` parameter.");
					node.arguments[index1] = t.literal(true);
					var index2 = findIndex(node.arguments, is_);
					if (index2 >= 0) {
						node.arguments[index2] = t.literal(true);
						if (findIndex(node.arguments, is_) >= 0) throw state.errorWithNode(node, "async call cannot have more than 2 _ arguments");
						return awaitCall(t, scope, state, node, index1, index2, false);
					}
					return awaitCall(t, scope, state, node, index1, null, false);
				}
				if ((index1 = findIndex(node.arguments, isFutureArg)) >= 0) {
					node.arguments[index1] = t.literal(false);
					return futureCall(t, scope, state, node, index1);
				}
				if ((index1 = findIndex(node.arguments, isPromiseArg)) >= 0) {
					node.arguments[index1] = t.literal(false);
					return t.memberExpression(futureCall(t, scope, state, node, index1), t.identifier('promise'));
				}
				if ((index1 = findIndex(node.arguments, isRShift_)) >= 0) {
					state.streamline.fastLocs.push(node.arguments[index1].loc);
					node.arguments[index1] = node.arguments[index1].right;
					return node;
				}
				if ((index1 = findIndex(node.arguments, isArray_)) >= 0) {
					node.arguments[index1] = t.literal(true);
					return awaitCall(t, scope, state, node, index1, null, true);
				}
				if (is_(callee) && node.arguments.length === 2) {
					state.streamline.fastLocs.push(node.loc);
					return node.arguments[0];
				}
				if (funcScope.block.isStreamline) {
					// handle CoffeeScript IIFE 
					var innerFunc = unwrapIIFE(t, node);
					if (innerFunc && !innerFunc.isStreamline) {
						// this is a CS IIFE - (and we are not recursing)
						innerFunc.isStreamline = true;
						if (state.streamline.runtime.async) {
							innerFunc.async = true;
							return t.awaitExpression(node);
						} else if (state.streamline.runtime.generator) {
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
				state.streamline.hasGenerator = true;
			},
			BlockStatement: function(node, parent, scope, state) {
				return t.blockStatement(hoist(t, scope, node.body));
			},
		}
	});
}