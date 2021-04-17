'use strict';
const { CalmService } = require( '../../../system/core/CalmService' );

class SampleService extends CalmService {
    constructor( model ) {
        super( model );
    }
}

module.exports = { SampleService };
