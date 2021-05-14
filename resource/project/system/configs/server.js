'use strict';
const express = require('express');
const helmet = require( 'helmet' );
const cors = require('cors');
const server = express();
const { setRoutes } = require('./routing');
// Apply Helmet Security
server.use(helmet());
// CORS Configuration
server.use(cors({ origin: '*' }));
// Setup Body Parser
server.use(express.json());
server.use(express.urlencoded({ extended: true }));

// Setup Routes
setRoutes(server);
module.exports = {
    server
};
