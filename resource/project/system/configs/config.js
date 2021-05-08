'use strict';
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = {
    EXCLUDED_ITEMS_FROM_RESPONSE: [ 'password', '__v' ],
    PORT: 5001,
    MONGODB_URI: process.env.MONGODB_URI
};
/**
 * Load Configuration
 * @returns {Object} Configuration
 */
const loadConfig = () => {
    let finalConfig = { ...config };
    try {
        const userConfigPath = path.resolve(__dirname, '../../src/configs/config.js');
        const userConfigExists = fs.existsSync(userConfigPath);
        if(userConfigExists) {
            const { config: userConfig } = require(userConfigPath);
            if( typeof userConfig === 'object' && Object.keys(userConfig).length) {
                finalConfig = { ...finalConfig, ...userConfig };
                console.log(chalk.greenBright('✔ Custom Configurations Loaded'));
            } else {
                throw new Error('No Custom Configurations found');
            }
        }else {
            throw new Error('No Custom Configurations found');
        }
    }catch (e) {
        console.log(chalk.blueBright('✔', e.message, '* Using Defaults only'));
    }
    return finalConfig;
};

module.exports = {
    config: loadConfig()
};
