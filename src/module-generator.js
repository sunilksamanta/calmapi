'use strict';
const CURR_DIR = process.cwd();
const fs = require('fs');
const pluralize = require('pluralize');
const chalk = require('chalk');
const caseChanger = require('case');

module.exports = async function(modulePath, isForce = false) {
    try {
        const modulePathArr = modulePath.split('/');
        let finalModulePath = `${CURR_DIR}`;
        
        let finalModuleName = modulePathArr;

        if(!isForce) {
            finalModuleName = pluralize.singular(modulePathArr.pop());
        }

        const kebabCase = caseChanger.kebab(finalModuleName);
        let moduleDirPath;
        if(!finalModulePath.split('/').find(file => file === 'modules')) {
            finalModulePath = `${CURR_DIR}/src/modules`;
            moduleDirPath = `${finalModulePath}/${kebabCase}`;
        }else{
            moduleDirPath = `${finalModulePath}/${finalModuleName}`;
        }
        const templatePath = `${__dirname}/../resource/modules/sample`;

        console.log(chalk.blueBright(`Creating Module: ${finalModuleName}`));
        console.log(chalk.blueBright(`Creating Directory: ${kebabCase}`));
        fs.mkdirSync(`${moduleDirPath}`);
        console.log(chalk.blueBright('Generating Files'));
        // eslint-disable-next-line no-use-before-define
        await createDirectoryContents(templatePath, finalModuleName, moduleDirPath);
        console.log(chalk.blueBright('Module Generation Complete'));
    } catch (error) {
        if(error.code === 'EEXIST') {
            console.error(chalk.redBright('Module already exists.'));
        } else {
            console.error(chalk.redBright(error.message));
        }
    }
};

// eslint-disable-next-line func-style
async function createDirectoryContents(templatePath, moduleName, moduleWritePath) {
    try {
        const filesToCreate = fs.readdirSync(templatePath);
        filesToCreate.forEach((file) => {
            const origFilePath = `${templatePath}/${file}`;

            // get stats about the current file
            const stats = fs.statSync(origFilePath);
            const destinationPath = moduleWritePath.split('/');
            const pathCount = destinationPath.slice(destinationPath.indexOf('src'));
            const pathLink = '../';
            let finalPathLink = '';
            let routeFilePathLink = '';
            let counter = pathCount.length;
            let routeFilePathCounter = pathCount.length - 2;
            while(counter > 0) {
                finalPathLink += pathLink;
                counter--;
            }
            while(routeFilePathCounter > 0) {
                routeFilePathLink += pathLink;
                routeFilePathCounter--;
            }

            if (stats.isFile()) {
                let contents = fs.readFileSync(origFilePath, 'utf8');
                const PascalCase = caseChanger.pascal(moduleName);
                const camelCase = caseChanger.camel(moduleName);
                const kebabCase = caseChanger.kebab(moduleName);
                switch (file) {
                    case 'sample.controller.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.controller.js`;
                        contents = contents.replace(/PATH_LINK/g, finalPathLink);
                        contents = contents.replace(/MODULE_SINGULAR_PASCAL/g, PascalCase);
                        contents = contents.replace(/MODULE_SINGULAR_CAMEL/g, camelCase);
                        contents = contents.replace(/MODULE_SINGULAR_KEBAB/g, kebabCase);
                        break;
                    case 'sample.dto.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.dto.js`;
                        break;
                    case 'sample.model.js':
                        contents = contents.replace(/MODULE_SINGULAR_PASCAL/g, PascalCase);
                        contents = contents.replace(/MODULE_SINGULAR_CAMEL/g, camelCase);
                        contents = contents.replace(/MODULE_SINGULAR_KEBAB/g, kebabCase);
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.model.js`;
                        break;
                    case 'sample.route.js':
                        contents = contents.replace(/PATH_LINK/g, routeFilePathLink);
                        contents = contents.replace(/MODULE_SINGULAR_PASCAL/g, PascalCase);
                        contents = contents.replace(/MODULE_SINGULAR_CAMEL/g, camelCase);
                        contents = contents.replace(/MODULE_SINGULAR_KEBAB/g, kebabCase);
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.route.js`;
                        break;
                    case 'sample.service.js':
                        contents = contents.replace(/PATH_LINK/g, finalPathLink);
                        contents = contents.replace(/MODULE_SINGULAR_PASCAL/g, PascalCase);
                        contents = contents.replace(/MODULE_SINGULAR_CAMEL/g, camelCase);
                        contents = contents.replace(/MODULE_SINGULAR_KEBAB/g, kebabCase);
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.service.js`;
                        break;
                    case 'sample.settings.js':
                        // eslint-disable-next-line no-param-reassign
                        file = `${kebabCase}.settings.js`;
                        break;
                    default:
                        break;
                }
                const writePath = `${moduleWritePath}/${file}`;
                fs.writeFileSync(writePath, contents, 'utf8');
                console.log(chalk.greenBright(writePath));
            }

        });
    } catch (error) {}
}
