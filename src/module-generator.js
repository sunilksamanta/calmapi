"use strict";
const CURR_DIR = process.cwd();
const fs = require("fs");
const pluralize = require( 'pluralize' );
const {capitalCase} = require('change-case')

module.exports = function (moduleName) {
  try {
    console.log(pluralize.singular(moduleName) );
    const finalModuleName = pluralize.singular(moduleName);
    fs.mkdirSync(`${CURR_DIR}/${finalModuleName}`);
    const templatePath = `${__dirname}/../resource/modules/sample`;
    createDirectoryContents(templatePath, finalModuleName);
  } catch (error) {}
};

function createDirectoryContents(templatePath, moduleName) {
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
            //   contents = contents.replace('sample', smallCaseModuleName);
            //   contents = contents.replace('Sample', capitalCaseModuleName);

              break;
            case "sample.dto.js":
              file = `${moduleName}.dto.js`;
              break;
            case "sample.model.js":
              file = `${moduleName}.model.js`;
              break;
            case "sample.route.js":
              file = `${moduleName}.route.js`;
              break;
            case "sample.service.js":
              file = `${moduleName}.service.js`;
              break;
            case "sample.settings.js":
              file = `${moduleName}.settings.js`;
              break;
            default:
              break;
          }
        const writePath = `${CURR_DIR}/${moduleName}/${file}`;
        console.log(file);
        console.log(writePath);
        fs.writeFileSync(writePath, contents, "utf8");
      }
      
    });
  } catch (error) {}
}
