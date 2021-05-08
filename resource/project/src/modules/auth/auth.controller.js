const { AuthService } = require( './auth.service' );
const { Auth } = require( './auth.model' );
const { User } = require( '../user/user.model' );
const autoBind = require( 'auto-bind' );
const authDTO = require( './auth.dto' );
const userDTO = require( '../user/user.dto' );
const authService = new AuthService( new Auth().getInstance(), new User().getInstance() );

class AuthController {

    constructor( service ) {
        this.service = service;
        this.dto = authDTO;
        this.userDTO = userDTO;
        autoBind( this );
    }

    async login( req, res, next ) {
        try {
            const loginData = new this.dto.LoginRequestDTO( req.body );
            const response = await this.service.login( loginData.email, loginData.password );
            res.sendCalmResponse( new this.dto.LoginResponseDTO( response.data ) );
        } catch ( e ) {
            next( e );
        }
    }

    async register( req, res, next ) {
        try {
            const registerData = new this.dto.RegisterRequestDTO( { ...req.body } );
            const response = await this.service.register( registerData );
            res.sendCalmResponse( new this.dto.RegisterResponseDTO( response.data ) );
        } catch ( e ) {
            next( e );
        }
    }

    async requestPasswordReset( req, res, next ) {
        try {
            const { email } = req.body;
            const { otp } = await this.service.requestPasswordReset( email );
            console.log('OTP', otp);
            // Send Email
            res.sendCalmResponse( null );
        } catch ( e ) {
            next( e );
        }
    }


    async resetPassword( req, res, next ) {
        try {
            const { email, otp, password } = req.body;
            if( !email || !otp || !password ) {
                const error = new Error( 'Email, OTP & Password is required' );
                error.statusCode = 422;
                throw error;
            }
            await this.service.resetPassword( email, otp, password );

            res.sendCalmResponse( null, { 'updated': true } );
        } catch ( e ) {
            next( e );
        }
    }

    async changePassword( req, res, next ) {
        try {
            const id = req.user._id;
            await this.service.changePassword( id, req.body.password );
            res.sendCalmResponse( null, { 'updated': true } );
        } catch ( e ) {
            next( e );
        }
    }

    async getProfile( req, res, next ) {
        try{
            const id = req.user._id;
            const response = await this.service.getProfile( id );
            res.sendCalmResponse( new this.userDTO.GetDTO( response.data ) );

        } catch ( e ) {
            next( e );
        }
    }

    async updateProfile( req, res, next ) {
        try{
            const id = req.user._id;
            await this.service.updateProfile( id, new this.userDTO.GetDTO( req.body ) );
            res.sendCalmResponse( null, { 'updated': true } );

        } catch ( e ) {
            next( e );
        }
    }

    async logout( req, res, next ) {
        try {
            await this.service.logout( req.token );
            res.sendCalmResponse( null, { 'deleted': true } );
        } catch ( e ) {
            next( e );
        }
    }

    async checkLogin( req, res, next ) {
        try {
            const token = this.extractToken( req );

            req.user = await this.service.checkLogin( token );
            req.authorized = true;
            req.token = token;
            next();
        } catch ( e ) {
            next( e );
        }
    }

    /**
     * Checks if the user is logged in and its optional, If logged in the user object is injected into req.
     * @param req
     * @param res
     * @param next
     * @returns {Promise<void>}
     */
    async optionalCheckLogin( req, res, next ) {
        try {
            const token = this.extractToken( req );

            req.user = await this.service.checkLogin( token );
            req.authorized = true;
            req.token = token;
            next();
        } catch ( e ) {
            next();
        }
    }

    extractToken( req ) {
        if ( req.headers.authorization && req.headers.authorization.split( ' ' )[ 0 ] === 'Bearer' ) {
            return req.headers.authorization.split( ' ' )[ 1 ];
        } else if ( req.query && req.query.token ) {
            return req.query.token;
        }
        return null;
    }


}

module.exports = new AuthController( authService );
