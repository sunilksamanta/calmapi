'use strict';
const { CalmService } = require( '../../../system/core/CalmService' );

class PostService extends CalmService {
    constructor( model ) {
        super( model );
    }

}

module.exports = { PostService };
