'use strict';
const { S3Client, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuid } = require('uuid');

class S3Upload {
    constructor() {
        this.S3 = new S3Client({
            credentials: {
                accessKeyId: process.env.ACCESS_KEY_ID,
                secretAccessKey: process.env.SECRET_ACCESS_KEY,
            },
            region: process.env.REGION || 'ap-south-1'
        });
    }

    /**
   * Upload file to S3
   * @returns {Promise<import("@aws-sdk/client-s3").PutObjectCommandOutput>}
   * @param {Buffer|Stream|string} buffer - File data
   * @param {string} fileName - Original filename
   * @param {object} ops - Options (ACL, pathPrefix, etc.)
   */
    async uploadFile(buffer, fileName, ops = { ACL: 'public-read' }) {
        try {
            const fileType = fileName.split('.').pop();
            let Key = `${new Date().getFullYear()}/${(`0${new Date().getMonth() + 1}`).slice(-2)}/${uuid()}.${fileType}`;

            if (ops.pathPrefix) {
                Key = `${ops.pathPrefix}/${Key}`;
            }

            const params = {
                ACL: ops.ACL,
                Bucket: process.env.BUCKET_NAME,
                Key,
                Body: buffer
            };
            // The .promise() is not needed with v3 send, as it returns a promise already
            return await this.S3.send(new PutObjectCommand(params)); // Returns { Bucket, Key, Location, ETag }
        } catch (error) {
            throw error;
        }
    }


    /**
   * Generate a presigned URL for uploading to S3
   * @param {string} fileName - The original filename
   * @param {object} ops - Options (ACL, pathPrefix, contentType, expiresIn)
   * @returns {Promise<{url: string, key: string}>}
   */
    async getPresignedUploadUrl(fileName, ops = { ACL: 'public-read', expiresIn: 600 }) {
        const fileType = fileName.split('.').pop();
        let Key = `${new Date().getFullYear()}/${(`0${new Date().getMonth() + 1}`).slice(-2)}/${uuid()}.${fileType}`;
        if (ops.pathPrefix) {
            Key = `${ops.pathPrefix}/${Key}`;
        }
        const command = new PutObjectCommand({
            Bucket: process.env.BUCKET_NAME,
            Key,
            ACL: ops.ACL,
            ContentType: ops.contentType || 'application/octet-stream',
        });
        const url = await getSignedUrl(this.S3, command, { expiresIn: ops.expiresIn || 600 });
        return { url, key: Key };
    }

    /**
     * Delete file from S3
     * @param {string} Key The key of the object to delete.
     * @returns {Promise<import("@aws-sdk/client-s3").DeleteObjectCommandOutput>}
     */
    async deleteFile(Key) {
        try {
            const params = {
                Bucket: process.env.BUCKET_NAME,
                Key: Key
            };
            // The .promise() is not needed with v3 send, as it returns a promise already
            return this.S3.send(new DeleteObjectCommand(params));
        } catch (error) {
            throw error;
        }
    }
}

module.exports = { S3Upload };
