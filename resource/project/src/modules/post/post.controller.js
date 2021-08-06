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

    async getAll( req, res, next ) {
        try {
            // Example passing Populate Fields on method itself. To set global Populate refer to Service File
            const response = await this.service.getAll( req.query, {
                populateFields: [
                    { path: 'createdBy', select: 'name email' },
                    { path: 'updatedBy', select: 'name email' }
                ]
            } );
            res.sendCalmResponse( response.data.map( x => new this.dto.GetDTO( x ) ), { 'totalCount': response.total } );
        } catch ( e ) {
            next( e );
        }
    }

}

module.exports = new PostController( postService );
