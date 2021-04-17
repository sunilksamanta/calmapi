'use strict';

class GetDTO {
    constructor( { ...props } ) {
        Object.keys( props ).forEach( key => {
            this[ key ] = props[ key ];
        } );
        Object.freeze( this );
    }
}


class InsertDTO {
    constructor( { ...props } ) {
        Object.keys( props ).forEach( key => {
            this[ key ] = props[ key ];
        } );
        Object.freeze( this );
    }
}

class UpdateDTO {
    constructor( { ...props } ) {
        Object.keys( props ).forEach( key => {
            this[ key ] = props[ key ];
        } );
        Object.freeze( this );
    }
}

module.exports = { GetDTO, InsertDTO, UpdateDTO };
