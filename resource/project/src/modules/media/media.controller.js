'use strict';
const { CalmController } = require( '../../../system/core/CalmController' );
const { MediaService } = require( './media.service' );
const { Media } = require( './media.model' );
const autoBind = require( 'auto-bind' );
const multer = require( 'multer' );

const { S3Upload } = require('../../plugins');
const { CalmError } = require('../../../system/core/CalmError');

const mediaService = new MediaService(
    new Media().getInstance()
);

class MediaController extends CalmController {
    // file upload using multer
    storage = multer.memoryStorage( {
        'destination': function( req, file, callback ) {
            callback( null, '' );
        }
    } );

    upload = multer( {
        'storage': this.storage,
        'limits': {
            'fileSize': 1024 * 1024 * 25
        }
    } );

    constructor( service ) {
        super( service );
        this.S3Upload = new S3Upload();
        autoBind( this );
    }

    async insert( req, res, next ) {
        try {
            if(!req.file) {
                throw new CalmError('VALIDATION_ERROR', 'File is required');
            }
            const { key } = await this.S3Upload.uploadFile( req.file.buffer, req.file.originalname, { ACL: 'public-read', pathPrefix: 'uploads' } );
            const response = await this.service.insert( { ...req.file, 'path': key } );
            res.sendCalmResponse(response.data);
        } catch ( e ) {
            next( e );
        }
    }


    /**
     * Media Uploading Middleware
     * This can be used for any task which has media upload with other data.
     * Use this as middleware and get the file info in req.file in your router function
     * @param req
     * @param res
     * @param next
     * @returns {Promise<void>}
     */
    async insertMediaMiddleware( req, res, next ) {
        try {
            if(!req.file) {
                throw new CalmError('VALIDATION_ERROR', 'File is required');
            }
            const { key } = await this.S3Upload.uploadFile( req.file.buffer, req.file.originalname, { ACL: 'public-read', pathPrefix: 'uploads' } );
            // Modifying req.file before moving to the next
            req.file = await this.service.insert( { ...req.file, 'path': key } );
            next();
        } catch ( e ) {
            next( e );
        }
    }


    async delete( req, res, next ) {
        const { id } = req.params;

        try {
            const response = await this.service.delete( id );

            await this.S3Upload.deleteFile( response.data.path );
            res.sendCalmResponse(response.data, { deleted: true });
        } catch ( e ) {
            next( e );
        }
    }


}

module.exports = new MediaController( mediaService );
