'use strict';
const AWS = require( 'aws-sdk' );
const { 'v4': uuid } = require( 'uuid' );
class S3Upload {
    constructor() {
        this.S3 = new AWS.S3( {
            'accessKeyId': process.env.ACCESS_KEY_ID,
            'secretAccessKey': process.env.SECRET_ACCESS_KEY,
            'region': 'ap-south-1'
        } );
    }

    /**
     * Upload By Params
     * @returns {Promise<unknown>}
     * @param buffer
     * @param fileName
     * @param [ops] Options
     * @param {string} [ops.pathPrefix] Path Prefix
     * @param {'private' | 'public-read' | 'public-read-write' | 'aws-exec-read'} [ops.ACL] Path Prefix
     */
    async uploadFile( buffer, fileName, ops = { ACL: 'public-read' } ) {
        try {
            const fileType = fileName.split( '.' ).pop();
            let Key = `${new Date().getFullYear()}/${( `0${ new Date().getMonth() + 1}` ).slice( -2 )}/${uuid()}.${fileType}`;
            if(ops.pathPrefix) {
                Key = `${ops.pathPrefix}/${Key}`;
            }
            const params = {
                ACL: ops.ACL,
                Bucket: process.env.BUCKET_NAME,
                Key,
                Body: buffer
            };
            return new Promise( ( resolve, reject ) => {
                this.S3.upload( params, ( error, data ) => {
                    if ( error ) {
                        return reject( error );
                    }
                    return resolve( data );
                } );
            } );
        } catch (e) {
            throw e;
        }

    }

    async deleteFile( Key ) {
        return new Promise( ( resolve, reject ) => {
            this.S3.deleteObject( {
                'Bucket': process.env.BUCKET_NAME,
                'Key': Key
            }, ( error, data ) => {
                if ( error ) {
                    return reject( error );
                }
                return resolve( data );
            } );
        } );
    }
}
module.exports = { S3Upload };
