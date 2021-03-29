'use strict';
// Load .env File
require('dotenv').config();
// Load Database
require('./system/configs/database');
// Load Server
const {server} = require('./system/configs/server');
const {config} = require('./system/configs/config');

const chalk = require('chalk');
const packageInfo = require('./package.json');
console.log(chalk.greenBright.bold('⬤⬤ Welcome to Calm API! v', packageInfo.version, '⬤⬤'));


server.listen(process.env.PORT || config.PORT).on('error', (err) => {
    console.log(chalk.red('✘ Application failed to start'));
    console.error(chalk.red('✘', err.message));
    process.exit(0);
}).on('listening', () => {
    console.log(chalk.greenBright('✔ Application Started'));
    console.log(chalk.greenBright('✔ Keep Calm and REST'));
});
