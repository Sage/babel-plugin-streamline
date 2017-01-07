"use strict";

var colors = require('colors/safe');
var babel = require('babel-core');

function log(message) {
	console.log(colors.gray("[STREAMLINE-PLUGIN] " + message));
}

function warn(message) {
	console.warn(colors.yellow("[STREAMLINE-PLUGIN] " + message));
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

// safety net: we don't have a special file extension for typescript files 
// and typescript does not force us to import streamline-runtime in all source files.
// so we force transform automatically if we find streamline-runtime in the package.json dependencies.
function forcedByDependencies(filename) {
	if (!/\.ts$/.test(filename)) return null;
	var fs = require('fs');
	var fsp = require('path');
	function loadPackage(dir) {
		var path = fsp.join(dir, 'package.json');
		if (fs.existsSync(path)) return require(path);
		var ndir = fsp.join(dir, '..');
		if (ndir.length < dir.length && !/[\\\/]node_modules$/.test(ndir)) return loadPackage(ndir);
		else return null;
	}
	var pkg = loadPackage(fsp.resolve(fsp.dirname(filename)));
	if (!pkg) return false;
	return Object.keys(pkg.dependencies || {}).indexOf('streamline-runtime') >= 0 ||
		Object.keys(pkg.devDependencies || {}).indexOf('streamline-runtime') >= 0;
}

function configure(state) {
	if (!state.opts) state.opts = {};
	var opts = state.opts;
	if (!opts.runtime) {
		if (!quiet(state)) warn("streamline runtime not configured. Defaulting to callbacks");
		opts.runtime = "callbacks";
	}
	state.streamline = {
		forceTransform: opts.forceTransform || forcedByDependencies(state.file.opts.filename),
		runtime: runtimes[opts.runtime],
		fastLocs: [],
	};
	if (!state.streamline.runtime) throw new Error("invalid runtime configuration: " + opts.runtime);
}

function runtimeCall(t, state, name, args) {
	return t.CallExpression(
	t.memberExpression(
	t.identifier(state.streamline.runtimeVar), t.identifier(name)), args)
}

function streamlineCall(t, scope, state, node, method, index1, index2, returnArray) {
	var callee = node.callee;
	var object, property;
	if (t.isMemberExpression(callee)) {
		// Ugly hack to get proper resolution of _.wait, _.sleep, etc. inside .ts files
		if (is_(callee.object) && /\.ts$/.test(state.file.opts.filename)) {
			callee.object.name = '_streamlineRuntime._'
		}
		object = callee.object;
		property = callee.computed ? callee.property : t.stringLiteral(callee.property.name);
	} else {
		object = t.nullLiteral();
		property = callee;
	}

	var fn = t.callExpression(
		t.memberExpression(t.identifier(state.streamline.runtimeVar), t.identifier(method)),
		[
			t.identifier(state.streamline.filenameVar),
			t.numericLiteral(node.loc ? node.loc.start.line : 0),
			object,
			property,
			t.numericLiteral(index1 || 0),
			index2 != null ? t.numericLiteral(index2) : t.nullLiteral(),
			t.booleanLiteral(returnArray),
			t.arrayExpression(node.arguments),
		]);
	fn.loc = node.loc;
	return fn;
}

function awaitWrap(t, state, expression) {
	var rt = state.streamline.runtime;
	if (rt.async) return t.awaitExpression(expression);
	else if (rt.generator) return t.yieldExpression(expression);
	else return expression;
}

function awaitCall(t, scope, state, node, index1, index2, returnArray) {
	function isLocalStreamline(node) {
		var binding = scope.getBinding(node.callee.name);
		if (!binding || !binding.constant || !t.isVariableDeclarator(binding.path.node)) return false;
		var n = binding.path.node.init;
		if (t.isCallExpression(n) &&
			t.isMemberExpression(n.callee) &&
			t.isIdentifier(n.callee.object) &&
			n.callee.object.name === state.streamline.runtimeVar &&
			n.callee.property.name === 'async') return true;
		if (t.isFunctionExpression(n) &&
			n.params[index1] &&
			n.params[index1].name === '_') return true;
		return false;
	}

	function isArrayBuiltin(node) {
		if (t.isMemberExpression(node.callee) &&
			t.isIdentifier(node.callee.property) &&
			/^(forEach|map|filter|every|some|reduce|reduceRight|sort)_$/.test(node.callee.property.name) &&
			node.arguments[0] && // arg 0 has already been transformed to true
			t.isBooleanLiteral(node.arguments[0]) &&
			node.arguments[0].value === true &&
			((t.isFunctionExpression(node.arguments[1]) && node.arguments[1].id === null) ||
			 t.isArrowFunctionExpression(node.arguments[1])) &&
			node.arguments[1].params[0] &&
			node.arguments[1].params[0].name == '_' &&
			!node.generator && !node.async) {
			// thisObj parameter exists in reduce_, reduceRight_ but not in corresponding ES5 methods.
			// idem for beg, end parameters in sort
			// so we cannot optimize these calls if thisObj parameter is present.
			if (/^reduce/.test(node.callee.property.name) && node.arguments.length > 3) return false;
			if (/^sort/.test(node.callee.property.name) && node.arguments.length > 2) return false;
			return true;
		}
		return false;
	}

	if (state.streamline.runtime.name === "fibers" && index2 == null && !returnArray) {
		if (isLocalStreamline(node)) {
			return t.callExpression(t.memberExpression(node.callee, t.stringLiteral('fiberized-' + index1), true), node.arguments);
		}
		if (!state.streamline.fileOptions['protect-builtins'] && isArrayBuiltin(node)) {
			var name = node.callee.property.name.replace(/_$/, '');
			var args = node.arguments.slice(1);
			if (t.isFunctionExpression(node.arguments[1]))
				args[0] = t.functionExpression(null, args[0].params.slice(1), args[0].body, false, false);
			else
				args[0] = t.arrowFunctionExpression(args[0].params.slice(1), args[0].body, false);
			args[0].isStreamline = true;
			return t.callExpression(t.memberExpression(node.callee.object, t.identifier(name)), args);
		}
	}
	return awaitWrap(t, state, streamlineCall(t, scope, state, node, 'await', index1, index2, returnArray));
}

function futureCall(t, scope, state, node, index) {
	return streamlineCall(t, scope, state, node, 'future', index, null, false);
}

var functionWrapperTemplate = babel.template('$runtime$.async(function $id_$($params$) { $body$ }, $index$, $arity$)');

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
	var innerCall = functionWrapperTemplate({
		$runtime$: t.identifier(state.streamline.runtimeVar),
		$id_$: t.identifier(scope.generateUid(wrapName(node.id ? node.id.name : guessName(t, this.parent)))),
		$params$: params.slice(),
		$body$: body,
		$index$: t.numericLiteral(index),
		$arity$: t.numericLiteral(params.length),
	}).expression;
	var innerFunc = innerCall.arguments[0];
	if (node.type === 'ArrowFunctionExpression') innerFunc.type = node.type;
	innerFunc.generator = rt.generator;
	innerFunc.async = rt.async;
	innerFunc.isStreamline = true;
	return t.isObjectMethod(node) ? t.objectProperty(node.key, innerCall) : innerCall;
}

function streamlineNew(t, state, node, index) {
	return t.callExpression(
	runtimeCall(t, state, 'new', [
		t.identifier(state.streamline.filenameVar),
		t.numericLiteral(node.loc ? node.loc.start.line : 0), 
		node.callee, 
		t.numericLiteral(index)]), node.arguments);
}

var requireVarTemplate = babel.template("var $name = typeof require === 'function' ? require($path) : Streamline.require($path);");
var requireVarMemberTemplate = babel.template("var $name = (typeof require === 'function' ? require($path) : Streamline.require($path)).$member;");

function runtimePrologue(t, state) {
	var prologue = [];
	if (state.streamline.runtime.regenerator && state.streamline.hasGenerator) {
		prologue.push(requireVarTemplate({
			$name: t.identifier('regeneratorRuntime'),
			$path: t.stringLiteral('streamline-runtime/lib/callbacks/regenerator'),
		}));
	}
	if (canTransform(state)) {
		if (/\.ts$/.test(state.file.opts.filename) && !state.streamline.importFound) {
			// Typescript transpiler removes unreferenced _ top level variable. Restore it.
			prologue.push(requireVarMemberTemplate({
				$name: t.identifier('_'),
				$path: t.stringLiteral('streamline-runtime'),
				$member: t.identifier('_'),
			}));
		}
		prologue.push(requireVarTemplate({
			$name: t.identifier(state.streamline.runtimeVar),
			$path: t.stringLiteral('streamline-runtime/lib/' + state.streamline.runtime.name + '/runtime'),
		}));
		prologue.push(t.variableDeclaration('var', [t.variableDeclarator(t.identifier(state.streamline.filenameVar), t.stringLiteral(state.file.opts.filename))]))
	}
	return prologue;
}

var programWrapperTemplate = babel.template("$runtime$.async($arg$, 0, 1).call(this, function(err) { if (err) throw err; })");

function asyncProgramWrapper(t, state, node, scope) {
	var wrapper = t.functionExpression(t.identifier(scope.generateUid('')), [], //
		t.blockStatement(node.body), //
		state.streamline.runtime.generator, //
		state.streamline.runtime.async);

	return programWrapperTemplate({
		$runtime$: t.identifier(state.streamline.runtimeVar),
		$arg$: wrapper,
	});
}

function canTransform(state) {
	return state.streamline.forceTransform || /^(unknown|.*\._(js|coffee))$/.test(state.file.opts.filename);
}

function quiet(state) {
	var st = state.opts;
	return st && st.quiet;
}

function wrapName(name) {
	return /\$\$/.test(name) ? name : "$$" + name + "$$";
}

var varDeclTemplate = babel.template("var $name$ = $value$;");

function hoist(t, scope, nodes) {
	// Brute force hoisting by moving function bodies to top of enclosing functions
	var hoisted = nodes.filter(function(node) {
		return t.isFunctionDeclaration(node);
	}).map(function(node) {
		return varDeclTemplate({
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
	function traverseCall(path, state) {
		var node = path.node;
		var index = findIndex(node.arguments, isCallbackArg);
		if (index >= 0) {
			if (!state.streamline.programIsAsync) {
				state.streamline.programIsAsync = true;
				if (!quiet(state)) warn(path.buildCodeFrameError("warning: async call at top level").message);
			}
		} else {
			var innerFunc = unwrapIIFE(t, node);
			if (innerFunc) innerFunc.isIIFE = true;
		}
	}
	scope.traverse(node, {
		CallExpression: traverseCall,
		NewExpression: traverseCall,
		Function: function(path, state) {
			var node = path.node;
			if (!node.isIIFE) path.skip();
		},
	}, state);
	return state.streamline.programIsAsync;
}

function fileOptions(t, node) {
	var opts = {};
	if (!node.body[0]) return opts;
	(node.body[0].leadingComments || []).forEach(function(comment) {
		var re = /@streamline-([\w-]+)/g;
		var m;
		while ((m = re.exec(comment.value))) {
			opts[m[1]] = true;
		}
	});
	return opts;
}

module.exports = function(pluginArguments) {
	var t = pluginArguments.types;
	return {
		visitor: {
			Identifier: {
				exit: function(path, state) {
					var node = path.node;
					var scope = path.scope;
					if (!canTransform(state)) return;
					if (is_(node) && !node.done 
						&& node.loc // not generated by another transform
						&& !t.isImportSpecifier(path.parent) // ts marker
						&& !(t.isMemberExpression(path.parent))) {
						console.error(path.parent);
						throw path.buildCodeFrameError("unexpected _");
					}
				}
			},
			Program: {
				enter: function(path, state) {
					var node = path.node;
					if (node._entered) return;
					var parent = path.parent;
					var scope = path.scope;
					configure(state);

					//if (!quiet(state)) log("transforming " + state.file.opts.filename + ' (' + st.runtime + ')');
					state.streamline.runtimeVar = scope.generateUid('streamline');
					state.streamline.filenameVar = scope.generateUid('filename');
					state.streamline.fileOptions = fileOptions(t, node);
					node = t.program(hoist(t, scope, node.body));
					node._entered = true;
					node.isStreamline = checkProgramAsync(t, node, parent, scope, state);
					path.replaceWith(node);
				},
				exit: function(path, state) {
					var node = path.node;
					if (node._exited) return;
					var scope = path.scope;
					if (!canTransform(state) && !state.streamline.hasGenerator) return;
					if (state.streamline.fastLocs.length > 0) {
						if (!quiet(state)) warn(state.file.opts.filename + ": " + "obsolete fast syntax detected at lines " + state.streamline.fastLocs.map(function(loc) {
							return loc ? loc.start.line : '?';
						}).join(','));
					}
					var nodes = runtimePrologue(t, state).concat(state.streamline.programIsAsync ? asyncProgramWrapper(t, state, node, scope) : node.body);
					node = t.program(nodes.filter(function(n) { return !t.isNoop(n) }));
					// need to clean these _entered / _exited hacks - deal with them later
					node._entered = true;
					node._exited = true;
					path.replaceWith(node);
				}
			},
			ImportDeclaration: function(path, state) {
				// enable streamline on .ts files if streamline-runtime is imported
				if (path.node.source.value === 'streamline-runtime' && /\.ts$/.test(state.file.opts.filename)) {
					if (!forcedByDependencies(state.file.opts.filename)) throw new Error('project configuration is inconsistent: streamline-runtime dependency missing in package.json');
					state.streamline.forceTransform = true;
					state.streamline.importFound = true;
				}
			},
			Function: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				if (node.async || node.generator) state.streamline.hasGenerator = true;
				if (!canTransform(state)) return;
				var index;
				if ((index = findIndex(node.params, is_)) >= 0) {
					var isExport = t.isExportDeclaration(path.parent);
					if (t.isFunctionDeclaration(node) && node.loc && !isExport)
						throw path.buildCodeFrameError("nested function declaration");
					var param = node.params[index];
					node.params[index] = t.identifier(scope.generateUid('_'));
					param.$done = true;
					if (node.generator) throw path.buildCodeFrameError("parameter _ not allowed in generator function");
					if (node.async) throw path.buildCodeFrameError("parameter _ not allowed: function already marked `async`");
					var expr = streamlineFunction.call(this, t, state, node, scope, index);
					if (t.isExportNamedDeclaration(path.parent)) {
						var constDeclaration = t.variableDeclaration('const', [t.variableDeclarator(node.id, expr)]);
						path.replaceWith(constDeclaration);
					} else {
						// default export should be handled this way too!
						path.replaceWith(expr);
					}
				}
			},
			CallExpression: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				if (!canTransform(state)) return;
				var callee = node.callee;
				var index1;
				var funcScope = scope.getFunctionParent();
				if ((index1 = findIndex(node.arguments, isCallbackArg)) >= 0) {
					if (isTilde_(node.arguments[index1])) state.streamline.fastLocs.push(node.arguments[index1].loc);
					if (!funcScope.block.isStreamline) throw path.buildCodeFrameError("unexpected `_` argument: enclosing function does not have an `_` parameter.");
					node.arguments[index1] = t.booleanLiteral(true);
					var index2 = findIndex(node.arguments, is_);
					if (index2 >= 0) {
						node.arguments[index2] = t.booleanLiteral(true);
						if (findIndex(node.arguments, is_) >= 0) throw path.buildCodeFrameError("async call cannot have more than 2 _ arguments");
						path.replaceWith(awaitCall(t, scope, state, node, index1, index2, false));
					} else {
						path.replaceWith(awaitCall(t, scope, state, node, index1, null, false));
					}
				} else if ((index1 = findIndex(node.arguments, isFutureArg)) >= 0) {
					node.arguments[index1] = t.booleanLiteral(false);
					path.replaceWith(futureCall(t, scope, state, node, index1));
				} else if ((index1 = findIndex(node.arguments, isPromiseArg)) >= 0) {
					node.arguments[index1] = t.booleanLiteral(false);
					path.replaceWith(t.memberExpression(futureCall(t, scope, state, node, index1), t.identifier('promise')));
				} else if ((index1 = findIndex(node.arguments, isRShift_)) >= 0) {
					state.streamline.fastLocs.push(node.arguments[index1].loc);
					node.arguments[index1] = node.arguments[index1].right;
					path.replaceWith(node);
				} else if ((index1 = findIndex(node.arguments, isArray_)) >= 0) {
					node.arguments[index1] = t.booleanLiteral(true);
					path.replaceWith(awaitCall(t, scope, state, node, index1, null, true));
				} else if (is_(callee) && node.arguments.length === 2) {
					state.streamline.fastLocs.push(node.loc);
					path.replaceWith(node.arguments[0]);
				} else if (funcScope.block.isStreamline) {
					// handle CoffeeScript IIFE 
					var innerFunc = unwrapIIFE(t, node);
					if (innerFunc && !innerFunc.isStreamline) {
						// this is a CS IIFE - (and we are not recursing)
						innerFunc.isStreamline = true;
						if (state.streamline.runtime.async) {
							innerFunc.async = true;
							path.replaceWith(t.awaitExpression(node));
						} else if (state.streamline.runtime.generator) {
							innerFunc.generator = true;
							path.replaceWith(t.yieldExpression(node));
						} else {
							path.replaceWith(node);
						}
					}
				}
			},
			NewExpression: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				if (!canTransform(state)) return;
				var index;
				if ((index = findIndex(node.arguments, is_)) >= 0) {
					node.arguments[index] = t.booleanLiteral(true);
					path.replaceWith(awaitWrap(t, state, streamlineNew(t, state, node, index)));
				}
			},
			"YieldExpression|AwaitExpression": function(path, state) {
				// regenerator transform does not automatically add its variable to we do it (even on .js files)
				state.streamline.hasGenerator = true;
			},
			BlockStatement: function(path, state) {
				var node = path.node;
				var scope = path.scope;
				if (node._entered) return;
				node = t.blockStatement(hoist(t, scope, node.body));
				node._entered = true;
				path.replaceWith(node);
			},
		}
	};
}
