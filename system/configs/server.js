'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require( 'helmet' );
const cors = require('cors');
const server = express();
// Apply Helmet Security
server.use(helmet());
// CORS Configuration
server.use(cors({origin:'*'}))
// Setup Body Parser
server.use(bodyParser.json());
exports.server = server;
