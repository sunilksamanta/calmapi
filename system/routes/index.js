'use strict';
const router = require('express').Router;
const chalk = require('chalk');

// Define API Routes
// Load Default Modules here
console.log(chalk.greenBright('✔ Default Modules Loaded'));

// Load user Defined Modules Here
console.log(chalk.blueBright('✔ Custom Modules Loaded'));

module.exports = {apiRoutes: router};
