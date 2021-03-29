'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require( 'helmet' );
const cors = require('cors');
const server = express();
const {setRoutes} = require('./routing');
// Apply Helmet Security
server.use(helmet());
// CORS Configuration
server.use(cors({origin:'*'}))
// Setup Body Parser
server.use(bodyParser.json());
// Setup Routes
setRoutes(server);
module.exports = {
    server
};
