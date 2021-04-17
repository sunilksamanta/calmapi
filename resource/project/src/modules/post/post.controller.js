'use strict';
const { CalmController } = require( '../../../system/core/CalmController' );
const { PostService } = require( './post.service' );
const { Post } = require( './post.model' );
const postDTO = require( './post.dto' );
const autoBind = require( 'auto-bind' ),
    postService = new PostService(
        new Post().getInstance()
    );

class PostController extends CalmController {

    constructor( service ) {
        super( service );
        this.dto = { ...this.dto, ...postDTO };
        autoBind( this );
    }

}

module.exports = new PostController( postService );
