const app = require('./src/index.js');
const serverless = require('serverless-http');

exports.handler = serverless(app);