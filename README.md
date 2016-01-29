# babel-plugin-streamline

Enables [streamline.js](https://github.com/Sage/streamlinejs) in the [babel](https://babeljs.io/) eco-system.

## Installation

```sh
$ npm install babel-plugin-streamline
```

## Babel options

``` javascript
{
	plugins: ["streamline"]
	extensions: [".js", "._js"],
	extra: {
		streamline: {
			runtime: 'callbacks',
			// more
		}
	}
}
```

The `callbacks` runtime of streamline needs the `regenerator` plug-in which is included by default in babel 5.x.

The other runtimes (`fibers`, `generators`) do not need `regenerator` so you should blacklist it.

See the [babel API docs](https://babeljs.io/docs/usage/api/) for details.

## Links

* [Issues](https://github.com/Sage/streamlinejs/issues) are centralized in the streamlinejs GitHub repository.

## License

MIT.
