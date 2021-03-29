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
console.log(chalk.greenBright.bold.underline('⬤⬤ Welcome to Calm API! v', packageInfo.version, '⬤⬤'));

const PORT = process.env.PORT || config.PORT;
server.listen(PORT).on('error', (err) => {
    console.log(chalk.red('✘ Sorry!! We could not keep you calm because something just broke.'));
    console.error(chalk.red('✘', err.message));
    process.exit(0);
}).on('listening', () => {
    console.log(chalk.greenBright('✔ Application Started'));
    console.log(chalk.greenBright('✔ Listening on port', PORT));
    console.log(chalk.greenBright.bold('✔ Keep Calm and REST'));
});
