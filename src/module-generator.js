"use strict";
const CURR_DIR = process.cwd();
const fs = require("fs");
const pluralize = require( 'pluralize' );
const {capitalCase} = require('change-case');
const chalk = require('chalk');


module.exports = async function (modulePath) {
  try {
    const modulePathArr = modulePath.split('/');
    let finalModulePath = `${CURR_DIR}/src/modules`;
    const finalModuleName = pluralize.singular(modulePathArr.pop());
    // modulePathArr.splice(-1,1).forEach(filePath=>{
    //   fs.mkdirSync(filePath.toLowerCase())
    //   finalModulePath += filePath.toLowerCase(); 
    // })
    const moduleDirPath = `${finalModulePath}/${finalModuleName}`
    const templatePath = `${__dirname}/../resource/modules/sample`;
    console.log(chalk.blueBright(`${finalModuleName} folder creating... \n`));
    fs.mkdirSync(`${moduleDirPath}`);
    console.log(chalk.greenBright('module setup...'));
    await createDirectoryContents(templatePath, finalModuleName, moduleDirPath);
  } catch (error) {
    console.log(error);
  }
};

async function createDirectoryContents(templatePath, moduleName, moduleWritePath) {
  try {
    const filesToCreate = fs.readdirSync(templatePath);
    filesToCreate.forEach((file) => {
      const origFilePath = `${templatePath}/${file}`;

      // get stats about the current file
      const stats = fs.statSync(origFilePath);

      if (stats.isFile()) {
        let contents = fs.readFileSync(origFilePath, 'utf8');
        let smallCaseModuleName = moduleName.toLowerCase();
        let capitalCaseModuleName = capitalCase(moduleName);
        switch (file) {
            case "sample.controller.js":
              file = `${moduleName}.controller.js`;
              contents = contents.replace(/sample/g, smallCaseModuleName);
              contents = contents.replace(/Sample/g, capitalCaseModuleName);
              break;
            case "sample.dto.js":
              file = `${moduleName}.dto.js`;
              break;
            case "sample.model.js":
              contents = contents.replace(/sample/g, smallCaseModuleName);
              contents = contents.replace(/Sample/g, capitalCaseModuleName);
              file = `${moduleName}.model.js`;
              break;
            case "sample.route.js":
              contents = contents.replace(/sample/g, smallCaseModuleName);
              contents = contents.replace(/Sample/g, capitalCaseModuleName);
              file = `${moduleName}.route.js`;
              break;
            case "sample.service.js":
              contents = contents.replace(/sample/g, smallCaseModuleName);
              contents = contents.replace(/Sample/g, capitalCaseModuleName);
              file = `${moduleName}.service.js`;
              break;
            case "sample.settings.js":
              file = `${moduleName}.settings.js`;
              break;
            default:
              break;
          }
        const writePath = `${moduleWritePath}/${file}`;
        fs.writeFileSync(writePath, contents, "utf8");
      }
      
    });
  } catch (error) {}
}
