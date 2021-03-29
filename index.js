'use strict';
const chalk = require('chalk');
const packageInfo = require('./package.json');
console.log(chalk.black.bold.bgBlue('** Welcome to Calm API! v', packageInfo.version));
console.log(chalk.greenBright('Keep Calm and REST'));
