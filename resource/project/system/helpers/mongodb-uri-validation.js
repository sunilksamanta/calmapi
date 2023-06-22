'use strict';
const { parse } = require('mongodb-uri');

const validateMongoDBUri = ( uri ) => {
    try {
        parse( uri );
        return true;
    } catch ( error ) {
        return false;
    }
};

module.exports = { validateMongoDBUri };
