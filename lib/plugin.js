"use strict";
var _ = require('lodash');

var runtime = "fibers";

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

function runtimeCall(t, name, args) {
	return t.CallExpression(
		t.memberExpression(
			t.identifier('runtime'), 
			t.identifier(name)
		),
		args
	)
}

function asyncify(t, node, method, index) {
	var callee = node.callee;
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? 
		(callee.computed ? callee.property : t.literal(callee.property.name)) : callee;

	return t.callExpression(
		runtimeCall(t, method, [object, property, t.literal(index)]),
		node.arguments
	);
}

function promisify(t, node, index) {
	return asyncify(t, node, 'promisify', index);
}

function future(t, node, index) {
	return asyncify(t, node, 'future', index);
}

function callbackify(t, node, index) {
	var params = node.params.slice();
	return t[node.type](
		node.id, 
		node.params, 
		t.blockStatement(
			[
				t.returnStatement(
					t.callExpression(
						t.memberExpression(
							runtimeCall(t, 
								'callbackify', 
								[
									t.functionExpression(
										t.identifier((node.id || {}).name + '_'), 
										params,
										node.body,
										node.generator,
										runtime === "fibers" ? false : true
									),
									t.literal(index)
								]
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

function promisifyNew(t, node, index) {
	return t.callExpression(
		runtimeCall(t, 'promisifyNew', [node.callee, t.literal(index)]),
		node.arguments
	);
}

function runtimeRequires(t) {
	function decl(name, mod, path) {
		return 
	}
	var vars = [
			t.variableDeclarator(
				t.identifier('runtime'),
				t.callExpression(
					t.identifier('require'),
					[t.literal('streamline-runtime/lib/runtime-' + runtime)]
				)
			)
		];
	if (runtime === "promise") {
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

function awaitWrap(t, expression) {
	if (runtime === "fibers") return expression;
	else return t.awaitExpression(expression);
}

function asyncProgramWrapper(t, node) {
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

function canTransform(file) {
	return !(file.opts.filename && !/\._js$/.test(file.opts.filename))
}

module.exports = function(pluginArguments) {
	var Plugin = pluginArguments.Plugin;
	var t = pluginArguments.types;
	return new Plugin("streamline", {
		visitor: {
			Identifier: {
				exit: function(node, parent, scope, file) {
					if (!canTransform(file)) return;
					if (is_(node) && !node.done) {
						throw file.errorWithNode(node, "unexpected _");
					}
				}
			},
			Program: {
				enter: function(node, parent, scope, file) {
					console.error("transforming " + file.opts.filename);
				},
				exit: function(node, parent, scope, file) {
					if (!canTransform(file)) return;
					return t.program([runtimeRequires(t)].concat(scope.isAsync ? asyncProgramWrapper(t, node) : node.body));
				}
			},
			Function: {
				enter: function(node, parent, scope, file) {
					if (!canTransform(file)) return;
					var index;
					if ((index = _.findIndex(node.params, is_)) >= 0) {
						var param = node.params[index];
						param.$done = true;
						if (node.generator) throw file.errorWithNode(param, "parameter _ not allowed in generator function");
						if (node.async) throw file.errorWithNode(param, "parameter _ not allowed: function already marked `async`");
						return callbackify(t, node, index);
					}
				}
			},
			CallExpression: {
				enter: function(node, parent, scope, file) {
					if (!canTransform(file)) return;
					var callee = node.callee;
					var index;
					if ((index = _.findIndex(node.arguments, isCallbackArg)) >= 0) {
						node.arguments[index] = t.literal(true);
						var funcScope = scope.getFunctionParent();
						if (!funcScope.parent) {
							console.warn(file.errorWithNode(node.arguments[index], "warning: async call at top level").message);
							funcScope.isAsync = true;
						}
						return awaitWrap(t, promisify(t, node, index));
					}
					if ((index = _.findIndex(node.arguments, isFutureArg)) >= 0) {
						node.arguments[index] = t.literal(false);
						return future(t, node, index);
					}
					if ((index = _.findIndex(node.arguments, isRShift_)) >= 0) {
						node.arguments[index] = node.arguments[index].right;
						return node;
					}
					if (is_(callee) && node.arguments.length === 2) {
						return node.arguments[0];
					}
				}
			},
			NewExpression: {
				enter: function(node, parent, scope, file) {
					if (!canTransform(file)) return;
					var index;
					if ((index = _.findIndex(node.arguments, is_)) >= 0) {
						node.arguments[index] = t.literal(true);
						return awaitWrap(t, promisifyNew(t, node, index));
					}
				}
			}
		}
	});
}
