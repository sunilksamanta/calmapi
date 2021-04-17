'use strict';
const mongoose = require( 'mongoose' );
const { config } = require( './config' );
const chalk = require('chalk');

// Mongo Connection Class
class Connection {
    constructor() {
        const url = config.MONGODB_URI;

        mongoose.Promise = global.Promise;
        mongoose.set( 'useNewUrlParser', true );
        mongoose.set( 'useFindAndModify', false );
        mongoose.set( 'useCreateIndex', true );
        mongoose.set( 'useUnifiedTopology', true );
        this.connect( url ).then( () => {
            // eslint-disable-next-line no-console
            console.log( chalk.greenBright('✔ Database Connected') );
        } ).catch( ( err ) => {
            // eslint-disable-next-line no-console
            console.error( chalk.redBright(`✘ MONGODB ERROR: ${err.message}` ) );
        } );

    }

    async connect( url ) {
        try {
            await mongoose.connect( url );
        } catch ( e ) {
            throw e;
        }
    }
}

module.exports = new Connection();
