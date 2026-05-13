'use strict';

// Bypass webpack-cli serve command which leaks webpack internal properties
// (_assetEmittingPreviousFiles) into devServer options, failing WDS 5.x schema validation.
const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const configFactory = require('./webpack.pwa.js');

const config = configFactory({}, { mode: 'development' });
const { devServer: rawDevServerOptions = {}, ...webpackOnlyConfig } = config;

// Strip internal webpack properties (underscore-prefixed) that WDS schema rejects
const devServerOptions = Object.fromEntries(
  Object.entries(rawDevServerOptions).filter(([k]) => !k.startsWith('_'))
);

devServerOptions.host = process.env.HOST || '0.0.0.0';

const compiler = webpack(webpackOnlyConfig);
const server = new WebpackDevServer(devServerOptions, compiler);

server.start().catch(err => {
  console.error(err);
  process.exit(1);
});