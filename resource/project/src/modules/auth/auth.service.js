'use strict';
const { UserService } = require( '../user/user.service' );
const autoBind = require( 'auto-bind' );
const mongoose = require( 'mongoose' );
const { CalmError } = require('../../../system/core/CalmError');

class AuthService {
    constructor( model, userModel ) {
        this.model = model;
        this.userService = new UserService( userModel );
        this.userModel = userModel;
        autoBind( this );
    }

    /**
     *
     * @param email: String
     * @param password: String
     * @returns {Promise<any>}
     */
    async login( email, password ) {
        const { data } = await this.userService.findByEmail( email, true );
        const user = data;
        if ( !user ) {
            // User not found
            throw new CalmError('VALIDATION_ERROR', 'Invalid Email');
        } else {
            // Process Login
            try {
                if ( !user.status ) {
                    throw new CalmError('VALIDATION_ERROR', 'Account is Inactive');
                }
                // Check Password
                const passwordMatched = await user.comparePassword( password );

                if ( !passwordMatched ) {
                    throw new CalmError('VALIDATION_ERROR', 'Invalid Password');
                }
                const tokenData = await this.postLogin( user );

                return { 'data': tokenData.toJSON() };
            } catch ( e ) {
                throw e;
            }

        }
    }

    async postLogin( user ) {
        try {
            const token = await this.model.generateToken( JSON.parse( JSON.stringify( user ) ) );

            await this.model.create( { token, 'user': new mongoose.mongo.ObjectId( user._id ) } );
            return await this.model.findOne( { 'token': token } ).populate( 'user' );
        } catch ( e ) {
            throw e;
        }
    }

    async register( data ) {
        try {
            const userData = await this.userService.insert( data );
            return { 'data': userData.data };
        } catch ( error ) {
            throw error;
        }
    }

    async changePassword( id, data ) {
        try {
            return await this.userService.updatePassword( id, data );
        } catch ( error ) {
            throw error;
        }
    }

    async getProfile( id ) {
        try {
            const userData = await this.userService.get( id );
            return { 'data': userData.data };
        } catch ( error ) {
            throw error;
        }
    }

    async updateProfile( id, data ) {
        try {
            return await this.userService.updateProfile( id, data );
        } catch ( error ) {
            throw error;
        }
    }

    async updateUser( id, data ) {
        try {
            delete data.password;
            return await this.userService.update( id, data );
        } catch ( error ) {
            throw error;
        }
    }

    async logout( token ) {
        try {
            return await this.model.deleteOne( { token } );
        } catch ( error ) {
            throw error;
        }
    }

    async checkLogin( token ) {
        try {
            // Check if the token is in the Database
            const tokenInDB = await this.model.countDocuments( { token } );

            if ( !tokenInDB ) {
                throw new CalmError('UNAUTHORIZED_ERROR');
            }
            // Check the token is a valid JWT
            const user = await this.model.decodeToken( token );

            if ( !user ) {
                throw new CalmError('UNAUTHORIZED_ERROR');
            }
            // Check the Extracted user is active in DB
            const userFromDb = await this.userService.get( user._id );

            if ( userFromDb.data ) {
                return userFromDb.data;
            }
            throw new CalmError('UNAUTHORIZED_ERROR');

        } catch ( e ) {
            throw new CalmError('UNAUTHORIZED_ERROR');
        }
    }

    async requestPasswordReset( email ) {
        try {
            const { data } = await this.userService.findByEmail( email );
            const otp = this.getRandomInt( 111111, 999999 );
            data.otp = otp;
            const expiry = new Date();
            expiry.setMinutes( expiry.getMinutes() + 30 );
            data.otpExpiry = expiry;
            data.save();
            return { otp };
        } catch ( e ) {
            throw e;
        }
    }

    async resetPassword( email, otp, password ) {
        try {
            const { data } = await this.userService.findByEmail( email );
            if( data.otp !== otp ) {
                throw new CalmError('VALIDATION_ERROR', 'Invalid OTP');
            }
            if( data.otpExpiry < new Date() ) {
                throw new CalmError('VALIDATION_ERROR', 'OTP Expired');
            }
            data.otp = '';
            data.otpExpiry = null;
            data.save();
            return await this.changePassword( data._id, password );
        } catch ( e ) {
            throw e;
        }
    }

    /**
     * Returns a random integer between min (inclusive) and max (inclusive).
     * The value is no lower than min (or the next integer greater than min
     * if min isn't an integer) and no greater than max (or the next integer
     * lower than max if max isn't an integer).
     * Using Math.round() will give you a non-uniform distribution!
     */
    getRandomInt( min, max ) {
        // eslint-disable-next-line no-param-reassign
        min = Math.ceil( min );
        // eslint-disable-next-line no-param-reassign
        max = Math.floor( max );
        return Math.floor( Math.random() * ( max - min + 1 ) ) + min;
    }

}

module.exports = { AuthService };
