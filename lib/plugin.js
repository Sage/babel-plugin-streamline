"use strict";

var colors = require('colors/safe');

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

function is_(x) {
	return x.type === 'Identifier' && x.name === '_' && !x.$done;
}

function isTilde_(x) {
	return x.type === 'UnaryExpression' && x.operator === '~' && is_(x.argument);
}

function isCallbackArg(x) {
	return is_(x) || isTilde_(x);
}

function isFutureArg(x) {
	return x.type === 'UnaryExpression' && x.operator === '!' && is_(x.argument);
}

function isRShift_(x) {
	return x.type === 'BinaryExpression' && x.operator === '>>' && is_(x.left);
}

function findIndex(array, pred) {
	for (var i = 0; i < array.length; i++)
		if (pred(array[i])) return i;
	return -1;
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

function streamlineCall(t, state, node, method, index) {
	var callee = node.callee;
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? 
		(callee.computed ? callee.property : t.literal(callee.property.name)) : callee;

	return t.callExpression(
		runtimeCall(t, state, method, [object, property, t.literal(index)]),
		node.arguments
	);
}

function awaitWrap(t, state, expression) {
	var rt = runtime(state);
	if (rt === "fibers") return expression;
	else return t.awaitExpression(expression);
}

function awaitCall(t, state, node, index) {
	return awaitWrap(t, state, streamlineCall(t, state, node, 'await', index));
}

function future(t, state, node, index) {
	return streamlineCall(t, state, node, 'future', index);
}

function streamlineFunction(t, state, node, index) {
	var params = node.params.slice();
	return t[node.type](
		node.id, 
		node.params, 
		t.blockStatement(
			[
				t.returnStatement(
					t.callExpression(
						t.memberExpression(
							runtimeCall(t, state,
								'async', 
								[
									t.functionExpression(
										t.identifier((node.id || {}).name + '_'), 
										params,
										node.body,
										node.generator,
										runtime(state) !== "fibers"
									),
									t.literal(index)
								],
								state
							),
							t.identifier('apply')
						),
						[t.thisExpression(), t.identifier('arguments')]
					)
				)
			]
		),
		node.generator, 
		false
	);
}

function streamlineNew(t, state, node, index) {
	return t.callExpression(
		runtimeCall(t, state, 'new', [node.callee, t.literal(index)]),
		node.arguments
	);
}

function runtimeRequires(t, state) {
	function decl(name, mod, path) {
		return 
	}
	var vars = [
			t.variableDeclarator(
				t.identifier(state.runtimeVar),
				t.callExpression(
					t.identifier('require'),
					[t.literal('streamline-runtime/lib/runtime-' + runtime(state))]
				)
			)
		];
	if (runtime === "callbacks") {
		vars.push(
			t.variableDeclarator(
				t.identifier('regeneratorRuntime'),
				t.memberExpression(
					t.identifier('runtime'),
					t.identifier('regeneratorRuntime')
				)
			)
		);
	}
	return t.variableDeclaration('var', vars);
}

function runtime(state) {
	var st = state.opts.extra.streamline;
	if (!st.runtime) {
		warn("streamline runtime not configured. Defaulting to await");
		st.runtime = "await";
	}
	return st.runtime;
}

function asyncProgramWrapper(t, state, node) {
	return t.expressionStatement(
		t.callExpression(
			t.memberExpression(
				t.callExpression(
					t.functionExpression(
						t.identifier(''), 
						[], 
						t.blockStatement(node.body), 
						false, 
						true), 
					[]
				), 
				t.identifier('then')
			), 
			[
				t.functionDeclaration(
					t.identifier(''), 
					[], 
					t.blockStatement([])
				),
				t.functionDeclaration(
					t.identifier(''), 
					[t.identifier('e')],
					t.blockStatement(
						[
							t.throwStatement(t.identifier('e'))
						]
					)
				)
			]
		)
	)
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
					if (verbose(state)) log("transforming " + state.opts.filename);
					state.runtimeVar = scope.generateUid('streamline');
				},
				exit: function(node, parent, scope, state) {
					if (!canTransform(state)) return;
					return t.program([runtimeRequires(t, state)].concat(scope.isAsync ? asyncProgramWrapper(t, state, node) : node.body));
				}
			},
			Function: {
				enter: function(node, parent, scope, state) {
					if (!canTransform(state)) return;
					var index;
					if ((index = findIndex(node.params, is_)) >= 0) {
						var param = node.params[index];
						param.$done = true;
						if (node.generator) throw state.errorWithNode(param, "parameter _ not allowed in generator function");
						if (node.async) throw state.errorWithNode(param, "parameter _ not allowed: function already marked `async`");
						return streamlineFunction(t, state, node, index);

					}
				}
			},
			CallExpression: {
				enter: function(node, parent, scope, state) {
					if (!canTransform(state)) return;
					var callee = node.callee;
					var index;
					if ((index = findIndex(node.arguments, isCallbackArg)) >= 0) {
						node.arguments[index] = t.literal(true);
						var funcScope = scope.getFunctionParent();
						if (!funcScope.parent) {
							console.warn(state.errorWithNode(node.arguments[index], "warning: async call at top level").message);
							funcScope.isAsync = true;
						}
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
					if (is_(callee) && node.arguments.length === 2) {
						return node.arguments[0];
					}
				}
			},
			NewExpression: {
				enter: function(node, parent, scope, state) {
					if (!canTransform(state)) return;
					var index;
					if ((index = findIndex(node.arguments, is_)) >= 0) {
						node.arguments[index] = t.literal(true);
						return awaitWrap(t, state, streamlineNew(t, state, node, index));
					}
				}
			}
		}
	});
}
