'use strict';
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require( "@aws-sdk/client-s3" );
const { 'v4': uuid } = require( 'uuid' );

class S3Upload {
    constructor() {
        this.S3 = new S3Client( {
            credentials: {
                accessKeyId: process.env.ACCESS_KEY_ID,
                secretAccessKey: process.env.SECRET_ACCESS_KEY,
            },
            region: process.env.REGION || 'ap-south-1'
        } );
    }

    /**
     * Upload By Params
     * @returns {Promise<import("@aws-sdk/client-s3").PutObjectCommandOutput>}
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
            // The .promise() is not needed with v3 send, as it returns a promise already
            return this.S3.send(new PutObjectCommand(params));
        } catch (e) {
            // Log the error for debugging purposes
            console.error("Error uploading file to S3:", e);
            throw e;
        }
    }

    /**
     * @param {string} Key The key of the object to delete.
     * @returns {Promise<import("@aws-sdk/client-s3").DeleteObjectCommandOutput>}
     */
    async deleteFile( Key ) {
        try {
            const params = {
                Bucket: process.env.BUCKET_NAME,
                Key: Key
            };
            // The .promise() is not needed with v3 send, as it returns a promise already
            return this.S3.send(new DeleteObjectCommand(params));
        } catch (e) {
            // Log the error for debugging purposes
            console.error("Error deleting file from S3:", e);
            throw e;
        }
    }
}
module.exports = { S3Upload };
