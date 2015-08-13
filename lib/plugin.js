"use strict";
var _ = require('lodash');

function is_(x) {
	return x.type === 'Identifier' && x.name === '_';
}

function isTilde_(x) {
	return x.type === 'UnaryExpression' && x.operator === '~' && is_(x.argument);
}

function isNot_(x) {
	return x.type === 'UnaryExpression' && x.operator === '!' && is_(x.argument);
}

function promisify(t, node, index) {
	var callee = node.callee;
	node.arguments.splice(index, 1);
	var object = callee.type === 'MemberExpression' ? callee.object : t.literal(null);
	var property = callee.type === 'MemberExpression' ? 
		(callee.computed ? callee.property : t.literal(callee.property.name)) : callee;
	return t.CallExpression(
		t.CallExpression(t.identifier('promisify'), [object, property, t.literal(index)]),
		node.arguments);
}

function wrapProgram(t, node) {
	return t.program(
		[
			t.expressionStatement(
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
						t.variableDeclarator(
							t.identifier('promisify'),
							t.memberExpression(
								t.identifier('runtime'),
								t.identifier('promisify')
							)
						)
					]
				)
			),
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
			Function: function(node, parent) {
				var index;
				if ((index = _.findIndex(node.params, is_)) >= 0) {
					if (node.generator) throw new TypeError("_ parameter not allowed: generator function");
					if (node.async) throw new TypeError("_ parameter not allowed: function already marked `async`");
					node.params.splice(index, 1);
					return t[node.type](node.id, node.params, node.body, node.generator, true);
				}
			},
			CallExpression: {
				exit: function(node, parent, scope) {
					var callee = node.callee;
					var index;
					if ((index = _.findIndex(node.arguments, is_)) >= 0) {
						var funcScope = scope.getFunctionParent();
						if (!funcScope.parent) {
							console.error("warning: async call at top level");
							funcScope.isAsync = true;
						}
						node.arguments.splice(index, 1);
						return t.awaitExpression(node);
					}
					if ((index = _.findIndex(node.arguments, isNot_)) >= 0) {
						node.arguments.splice(index, 1);
						return t.callExpression(node.callee, node.arguments);
					}
					if ((index = _.findIndex(node.arguments, isTilde_)) >= 0) {
						return t.awaitExpression(promisify(t, node, index));
					}
				}
			}
		}
	});
}