'use strict';
const mongoose = require( 'mongoose' );
const { Schema } = require( 'mongoose' );
const { JWTSignDTO } = require( './auth.dto' );
const jwt = require( 'jsonwebtoken' );
const { config } = require( '../../configs/config' );
const jwtKey = config.JWT_SECRET;
const jwtExpirySeconds = config.JWT_EXPIRY;

class Auth {

    initSchema() {
        const schema = new Schema( {
            'token': {
                'type': String,
                'required': true,
            },
            'user': {
                'type': Schema.Types.ObjectId,
                'required': true,
                'ref': 'user'
            }
        }, { 'timestamps': true } );

        schema.statics.generateToken = async function( user ) {
            // Create a new token with the user details
            try {
                return await jwt.sign( {
                    ...new JWTSignDTO( user )
                }, jwtKey, {
                    'algorithm': 'HS256',
                    'expiresIn': jwtExpirySeconds,
                } );
            } catch ( e ) {
                throw e;
            }
        };

        schema.statics.decodeToken = async function( token ) {
            // Create a new token with the user details
            try {
                return await jwt.verify( token, jwtKey );
            } catch ( e ) {
                throw e;
            }
        };
        try {
            mongoose.model( 'auth', schema );
        } catch ( e ) {

        }

    }

    getInstance() {
        this.initSchema();
        return mongoose.model( 'auth' );
    }
}

module.exports = { Auth };
