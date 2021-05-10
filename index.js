#!/usr/bin/env node
'use strict';
const inquirer = require('inquirer');
const CURR_DIR = process.cwd();
const fs = require('fs');
const childProcess = require('child_process');
const { paramCase } = require('change-case');
const packageInfo = require('./package.json');
const QUESTIONS = [
    {
        name: 'project-name',
        type: 'input',
        message: 'Project name:',
        validate: function(input) {
            const inputSanitized = input.trim();
            const projectDirectoryName = paramCase(inputSanitized);
            if(!(/^([A-Za-z\-\_ \d])+$/.test(inputSanitized))) {
                return 'Project name may only include letters, numbers, underscores and space.';
                // eslint-disable-next-line no-use-before-define
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
        default: (answers) => `mongodb://localhost:27017/${paramCase(answers[ 'project-name' ])}`,
        validate: function(input) {
            if (/^(mongodb(\+srv)?:(?:\/{2})?)((\w+?):(\w+?)@|:?@?)(\w+?):(\d+)\/(\w+?)$/.test(input)) {
                return true;
            }
            return 'Invalid MongoDB URI';
        }
    }
];
// eslint-disable-next-line func-style
async function main() {
    console.log('::: WELCOME TO CALM API :::\n');
    const answers = await inquirer.prompt(QUESTIONS);
    const projectName = answers[ 'project-name' ];
    const mongoUri = answers[ 'mongo-uri' ];
    const projectDirectoryName = paramCase(projectName);
    const templatePath = `${__dirname}/resource/project`;

    fs.mkdirSync(`${CURR_DIR}/${projectDirectoryName}`);
    // eslint-disable-next-line no-use-before-define
    createDirectoryContents(templatePath, projectDirectoryName, projectName, mongoUri);
    console.log(`:: Setting up ${projectName}.`);
    console.log(':: Installing Dependencies..');
    // eslint-disable-next-line no-use-before-define
    await npmInstall(`${CURR_DIR}/${projectDirectoryName}`);
    console.log(':: Setting up Git..');
    // eslint-disable-next-line no-use-before-define
    await gitSetup(`${CURR_DIR}/${projectDirectoryName}`);
    console.log(':: Project Setup Complete');
    console.log('\nWhat next?');
    console.log('\nGo to the project directory by running');
    console.log(`\ncd ${projectDirectoryName}\n`);
    console.log('\nStart the app by running');
    console.log('\nnpm start\n');
    console.log('\n\nPre Installed Modules\n\n');
    console.log('1. Auth: Register, Login, Password Reset, Profile\n');
    console.log('1. Post: CRUD\n');
    console.log('Edit the .env file located at the root of the project.');
    console.log('...::: Thank you for using CALM API :::...');
}

// eslint-disable-next-line func-style
function createDirectoryContents(templatePath, newProjectPath, projectName, mongoUri) {
    const filesToCreate = fs.readdirSync(templatePath);
    const skippedFiles = [ '.env', 'package-lock.json' ];

    filesToCreate.forEach(file => {
        const origFilePath = `${templatePath}/${file}`;

        // get stats about the current file
        const stats = fs.statSync(origFilePath);

        if (stats.isFile()) {
            if(skippedFiles.includes(file)) {
                return;
            }
            let contents = fs.readFileSync(origFilePath, 'utf8');
            // Rename
            if (file === '.npmignore') {
                // eslint-disable-next-line no-param-reassign
                file = '.gitignore';
            }
            if(file === 'package.json') {
                contents = contents.replace('"name": "calmapi"', `"name": "${newProjectPath}"`);
                contents = contents.replace('{{CALMAPI_VERSION}}', packageInfo.version);
            }
            if(file === '.env.sample') {
                contents = contents.replace('{{MONGODB_URI}}', mongoUri);
                // eslint-disable-next-line no-param-reassign
                file = '.env';
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
// eslint-disable-next-line func-style
async function npmInstall(where) {
    try {
        childProcess.execSync('npm install', { cwd: where, env: process.env, stdio: 'pipe' });
        childProcess.execSync('npm ci', { cwd: where, env: process.env, stdio: 'pipe' });
    } catch (e) {
        console.error(`Error Installing Packages ${ e.stderr}` ) ;
    }

}

// eslint-disable-next-line func-style
async function gitSetup(where) {
    try {
        childProcess.execSync('git init', { cwd: where, env: process.env, stdio: 'pipe' });
        childProcess.execSync('git add .', { cwd: where, env: process.env, stdio: 'pipe' });
        childProcess.execSync('git commit -m "Initial Setup"', { cwd: where, env: process.env, stdio: 'pipe' });
    } catch (e) {
        console.error(`Error Setting up Git ${ e.stderr}` ) ;
    }
}

// eslint-disable-next-line func-style
function directoryExistsCheck(projectDirectoryName) {
    try {
        return fs.existsSync(`${CURR_DIR}/${projectDirectoryName}`);
    } catch (e) {
        console.log(e);
    }
}
main();
