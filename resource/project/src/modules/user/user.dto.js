'use strict';

class GetDTO {
    constructor( { ...props } ) {
        this._id = props._id;
        this.email = props.email;
        this.name = props.name;
        Object.freeze( this );
    }
}
class InsertDTO {
    constructor( { ...props } ) {
        this.email = props.email;
        this.password = props.password;
        this.name = props.name;
        Object.freeze( this );
    }
}

class UpdateDTO {
    constructor( { ...props } ) {
        this.name = props.name;

        // Delete Fields which are not present in data
        Object.keys( this ).forEach( key => {
            if ( this[ key ] === undefined ) {
                delete this[ key ];
            }
        } );
        Object.freeze( this );
    }
}


module.exports = { GetDTO, InsertDTO, UpdateDTO };
