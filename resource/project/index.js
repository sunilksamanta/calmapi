'use strict';
// Load .env File
require('dotenv').config();
const chalk = require('chalk');
const packageInfo = require('./package.json');
console.log(chalk.greenBright.bold('⬤  CALMAPI - Keep Calm and REST'));
console.log(chalk.greenBright.bold('\n✔ Project: ', packageInfo.name, `v${ packageInfo.version}`));
console.log(chalk.greenBright.bold('✔ CalmAPI Version: ', packageInfo.generatorVersion));
console.log(chalk.greenBright('✔ Application Started'));
// Load Database
require('./system/configs/database');

// Load Server
const { server } = require('./system/configs/server');
const { config } = require('./system/configs/config');

const PORT = process.env.PORT || config.PORT;
server.listen(PORT).on('error', (err) => {
    console.log(chalk.red('✘ Sorry!! Something just broke.'));
    console.error(chalk.red('✘', err.message));
    process.exit(0);
}).on('listening', () => {
    console.log(chalk.greenBright('✔ Listening on port', PORT));
    console.log(chalk.greenBright.bold(`✔ Endpoint Base URL: http://127.0.0.1:${PORT}`));
});
