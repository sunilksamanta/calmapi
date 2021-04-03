'use strict';
const router = require('express').Router();
const chalk = require('chalk');
const { CalmResponse } = require('../core/CalmResponse');

router.use((req, res, next) => {
    res.sendCalmResponse = CalmResponse;
    res.sendCalmResponse.bind(res);
    next();
});

// Define API Routes
router.get('/', (req, res) => {
    // res.json({ status: true, message: 'API Running' });
    res.sendCalmResponse({ message: 'API Running' });

});
// Load Default Modules here
console.log(chalk.greenBright('✔ Default Modules Loaded'));

// Load user Defined Modules Here
console.log(chalk.blueBright('✔ Custom Modules Loaded'));

module.exports = { apiRoutes: router };
