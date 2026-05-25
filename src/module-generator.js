'use strict';
const CURR_DIR = process.cwd();
const fs = require('fs');
const pluralize = require('pluralize');
const readline = require('readline');
const chalk = require('chalk');
const caseChanger = require('case');
// eslint-disable-next-line func-style
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim().toLowerCase());
    }));
}
module.exports = async function(modulePath) {
    try {
        const modulePathArr = modulePath.split('/');
        const finalModulePath = `${CURR_DIR}/src/modules`;
        const finalModuleName = pluralize.singular(modulePathArr.pop());

        const kebabCase = caseChanger.kebab(finalModuleName);
        const moduleDirPath = `${finalModulePath}/${kebabCase}`;
        const templatePath = `${__dirname}/../resource/modules/sample`;
        const answer = await askQuestion(chalk.yellowBright('Do you want to generate an AI tool file for this module? (y/N): '));
        const generateToolFile = answer === 'y' || answer === 'yes';

        console.log(chalk.blueBright(`Creating Module: ${finalModuleName}`));
        console.log(chalk.blueBright(`Creating Directory: ${kebabCase}`));
        fs.mkdirSync(`${moduleDirPath}`);
        console.log(chalk.blueBright('Generating Files'));
        // eslint-disable-next-line no-use-before-define
        await createDirectoryContents(templatePath, finalModuleName, moduleDirPath, generateToolFile);

        console.log(chalk.greenBright('✔ Module Created'));
    } catch (error) {
        if(error.code === 'EEXIST') {
            console.error(chalk.redBright('Module already exists.'));
        } else {
            console.error(chalk.redBright(error.message));
        }
    }
};

// eslint-disable-next-line func-style
async function createDirectoryContents(templatePath, moduleName, moduleWritePath, generateToolFile) {
    try {
        const filesToCreate = fs.readdirSync(templatePath);
        filesToCreate.forEach((file) => {
            if (file === 'sample.tools.js' && !generateToolFile) {
                return;
            }
            const origFilePath = `${templatePath}/${file}`;

            // get stats about the current file
            const stats = fs.statSync(origFilePath);

            if (stats.isFile()) {
                let contents = fs.readFileSync(origFilePath, 'utf8');
                const PascalCase = caseChanger.pascal(moduleName);
                const camelCase = caseChanger.camel(moduleName);
                const kebabCase = caseChanger.kebab(moduleName);
                switch (file) {
                    case 'sample.controller.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.controller.js`;
                        break;
                    case 'sample.dto.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.dto.js`;
                        break;
                    case 'sample.model.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.model.js`;
                        break;
                    case 'sample.route.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.route.js`;
                        break;
                    case 'sample.service.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.service.js`;
                        break;
                    case 'sample.settings.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.settings.js`;
                        break;
                    case 'sample.tools.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.tools.js`;
                        break;
                    default:
                        break;
                }
                contents = contents.replace(/MODULE_SINGULAR_PASCAL/g, PascalCase);
                contents = contents.replace(/MODULE_SINGULAR_CAMEL/g, camelCase);
                contents = contents.replace(/MODULE_SINGULAR_KEBAB/g, kebabCase);

                const writePath = `${moduleWritePath}/${file}`;
                fs.writeFileSync(writePath, contents, 'utf8');
                console.log(chalk.greenBright(writePath));
            }

        });
    } catch (error) {
        console.error(chalk.redBright(error.message));
    }
}

