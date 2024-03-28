'use strict';
const mongoose = require( 'mongoose' );
const { config } = require( './config' );
const chalk = require('chalk');
const { validateMongoDBUri } = require('../helpers/mongodb-uri-validation');

// Mongo Connection Class
class Connection {
    constructor() {
        const url = config.MONGODB_URI;

        if ( !validateMongoDBUri( url ) ) {
            console.error(chalk.redBright( '✘ Invalid MongoDB URI' ));
            return;
        }

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
