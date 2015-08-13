"use strict";
var _ = require('lodash');

function is_(x) {
	return x.type === 'Identifier' && x.name === '_';
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

function runtimeCall(t, name, args) {
	return t.CallExpression(
		t.memberExpression(
			t.identifier('runtime'), 
			t.identifier(name)
		),
		args
	)
}

function promisify(t, node, index) {
	var callee = node.callee;
	node.arguments.splice(index, 1);
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? 
		(callee.computed ? callee.property : t.literal(callee.property.name)) : callee;

	return t.callExpression(
		runtimeCall(t, 'promisify', [object, property, t.literal(index)]),
		node.arguments
	);
}

function callbackify(t, node, index) {
	var params = node.params.slice();
	params.splice(index, 1);
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
										t.identifier(node.id.name + '_'), 
										params,
										node.body,
										node.generator,
										true
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

function wrapProgram(t, node) {
	return t.program(
		[
			//t.expressionStatement(
				t.variableDeclaration('var', 
					[
						t.variableDeclarator(
							t.identifier('runtime'),
							t.callExpression(
								t.identifier('require'),
								[t.literal('streamline-runtime')]
							)
						),
						t.variableDeclarator(
							t.identifier('regeneratorRuntime'),
							t.memberExpression(
								t.identifier('runtime'),
								t.identifier('regeneratorRuntime')
							)
						),
					]
				),
			//),
			t.expressionStatement(
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
		]
	);
}

module.exports = function(pluginArguments) {
	var Plugin = pluginArguments.Plugin;
	var t = pluginArguments.types;
	return new Plugin("streamline", {
		visitor: {
			Program: {
				exit: function(node, parent, scope) {
					if (scope.isAsync) {
						return wrapProgram(t, node);
					}
				}
			},
			Function: {
				exit: function(node, parent) {
					var index;
					if ((index = _.findIndex(node.params, is_)) >= 0) {
						if (node.generator) throw new TypeError("_ parameter not allowed: generator function");
						if (node.async) throw new TypeError("_ parameter not allowed: function already marked `async`");
						return callbackify(t, node, index);
					}
				}
			},
			CallExpression: {
				exit: function(node, parent, scope) {
					var callee = node.callee;
					var index;
					if ((index = _.findIndex(node.arguments, isCallbackArg)) >= 0) {
						var funcScope = scope.getFunctionParent();
						if (!funcScope.parent) {
							console.error("warning: async call at top level");
							funcScope.isAsync = true;
						}
						return t.awaitExpression(promisify(t, node, index));
					}
					if ((index = _.findIndex(node.arguments, isFutureArg)) >= 0) {
						node.arguments.splice(index, 1);
						return t.callExpression(node.callee, node.arguments);
					}
				}
			}
		}
	});
}