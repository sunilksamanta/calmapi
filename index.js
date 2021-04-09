#!/usr/bin/env node
'use strict';
const inquirer = require('inquirer');
const CURR_DIR = process.cwd();
const fs = require('fs');
const child_process = require('child_process');
const path = require('path');
const { paramCase } = require('change-case');

const QUESTIONS = [
    {
        name: 'project-name',
        type: 'input',
        message: 'Project name:',
        validate: function (input) {
            const inputSanitized = input.trim();
            const projectDirectoryName = paramCase(inputSanitized);
            if(!(/^([A-Za-z\-\_ \d])+$/.test(inputSanitized))) {
                return 'Project name may only include letters, numbers, underscores and space.';
            } else if(directoryExistsCheck(projectDirectoryName)) {
                return `Directory already exists with name "${projectDirectoryName}"`;
            }
            return true;
        }
    },
    {
        name: 'mongo-uri',
        type: 'input',
        message: 'MongoDB URI:',
        // validate: function (input) {
        //     if (/^([A-Za-z\-\_\b\d])+$/.test(input)) return true;
        //     else return 'Project name may only include letters, numbers, underscores and space.';
        // }
    }
];
async function main() {
    console.log('::: WELCOME TO CALM API :::\n');
    const answers = await inquirer.prompt(QUESTIONS);
    const projectName = answers['project-name'];
    const mongoUri = answers['mongo-uri'];
    const projectDirectoryName = paramCase(projectName);
    const templatePath = `${__dirname}/resource/project`;

    fs.mkdirSync(`${CURR_DIR}/${projectDirectoryName}`);
    createDirectoryContents(templatePath, projectDirectoryName, projectName, mongoUri);
    console.log(`:: Setting up ${projectName}.`);
    console.log(':: Installing Dependencies..');
    await npm_install(`${CURR_DIR}/${projectDirectoryName}`);
    console.log(':: Project Setup Complete');
    console.log('\nWhat next?');
    // console.log('Edit the .env file located at the root of the project.');
    // console.log('...::: Thank you for using MEAN CLOUD CLI :::...');
    console.log(answers, projectDirectoryName);
    console.log(CURR_DIR);
}

function createDirectoryContents (templatePath, newProjectPath, projectName, mongoUri) {
    const filesToCreate = fs.readdirSync(templatePath);

    filesToCreate.forEach(file => {
        const origFilePath = `${templatePath}/${file}`;

        // get stats about the current file
        const stats = fs.statSync(origFilePath);

        if (stats.isFile()) {
            let contents = fs.readFileSync(origFilePath, 'utf8');
            // Rename
            if (file === '.npmignore') file = '.gitignore';
            if(file === 'package.json') {
                contents = contents.replace("{{PROJECT_NAME}}", projectName);
            }
            if(file === '.env') {
                contents = contents.replace("{{MONGO_URL}}", mongoUri);
            }

            const writePath = `${CURR_DIR}/${newProjectPath}/${file}`;
            fs.writeFileSync(writePath, contents, 'utf8');
        } else if (stats.isDirectory()) {
            fs.mkdirSync(`${CURR_DIR}/${newProjectPath}/${file}`);

            // recursive call
            createDirectoryContents(`${templatePath}/${file}`, `${newProjectPath}/${file}`, projectName);
        }
    });
}

// Performs `npm install`
async function npm_install(where) {
    try {
        let stdout = child_process.execSync('npm install', { cwd: where, env: process.env, stdio: 'pipe' });
    } catch (e) {
        console.error("Error Installing Packages " + e.stderr ) ;
    }

}

function directoryExistsCheck(projectDirectoryName) {
    try {
        return fs.existsSync(`${CURR_DIR}/${projectDirectoryName}`);
    } catch (e) {
        console.log(e);
    }
}
main();