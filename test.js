var assert = require('assert');
var pf = require('point-free');
var pg = require('./index').configure('postgres://postgres@localhost/pg_bricks');
if (process.env.PGBRICKS_TEST_NATIVE) {
    pg = pg.native;
}


var INITIAL = [
    {title: 'apple', price: 10},
    {title: 'orange', price: 20},
]


describe('pg-bricks', function () {
    before(function (done) {
        // Create test database and fill a test data
        var pgsu = require('./index').configure('postgres://postgres@localhost/postgres');

        pf.serial(
            pgsu.raw('drop database if exists pg_bricks').run,
            pgsu.raw('create database pg_bricks').run,
            pg.raw('create table item (id serial, title text, price int)').run,
            pg.insert('item', INITIAL).run
        )(function (err, res) {
            done(err);
        })
    })


    it('should run query', function (done) {
        pg.raw('select 42 as x').run(function (err, res) {
            assert.ifError(err);
            assert.equal(res.command, 'SELECT');
            assert.deepEqual(res.rows, [{x: 42}]);
            done();
        })
    })

    it('should run query from client', function (done) {
        pg.run(function (client, callback) {
            client.raw('select 42 as x').run(function (err, res) {
                assert.ifError(err);
                assert.deepEqual(res.rows, [{x: 42}]);
                done();
            })
        }, done)
    })

    it('should support sql-bricks', function (done) {
        pf.waterfall(
            pg.select('title', 'price').from('item').run,
            function (res, callback) {
                assert.deepEqual(res.rows, INITIAL);
                done();
            }
        )(done)
    })

    describe('Accessors', function () {
        it('should provide .rows', function (done) {
            pf.waterfall(
                pg.select('title', 'price').from('item').rows,
                function (rows, callback) {
                    assert.deepEqual(rows, INITIAL);
                    done();
                }
            )(done)
        })

        it('should provide .col', function (done) {
            pf.waterfall(
                pg.select('title').from('item').col,
                function (col, callback) {
                    assert.deepEqual(col, ['apple', 'orange']);
                    done();
                }
            )(done)
        })

        it('should provide .val', function (done) {
            pf.waterfall(
                pg.select('price').from('item').where({title: 'apple'}).val,
                function (price, callback) {
                    assert.equal(price, 10);
                    done();
                }
            )(done)
        })

        it('should provide .val on .raw', function (done) {
            pf.waterfall(
                pg.raw('select price from item where title = $1', ['apple']).val,
                function (price, callback) {
                    assert.equal(price, 10);
                    done();
                }
            )(done)
        })
    })

    describe('Promises', function () {
        it('should return promise', function () {
            var res = pg.raw('select 42 as x').run();
            assert(res instanceof Promise);
        })

        it('should work with raw', function () {
            return pg.raw('select 42 as x').run().then(function (data) {
                assert.deepEqual(data.rows, [{x: 42}])
            })
        })

        it('should support sql-bricks', function () {
            return pg.raw('select 42 as x').run().then(function (data) {
                assert.deepEqual(data.rows, [{x: 42}])
            })
        })

        it('should work with accessors', function () {
            return pg.select('title,price').from('item').where({title: 'apple'}).row()
            .then(function (row) {
                assert.deepEqual(row, {title: 'apple', price: 10});
            })
        })
    })

    describe('Enclosures', function () {
        it('should manage client', function (done) {
            var idle = pg._pool.idleCount;
            pg.run(function (client, callback) {
                assert.equal(pg._pool.idleCount, idle - 1);
                callback()
            }, function (err) {
                assert.equal(pg._pool.idleCount, idle);
                done(err);
            })
        })

        it('should wrap in transaction', function (done) {
            pg.transaction(function (client, callback) {
                pf.serial(
                    client.update('item', {price: 42}).where('title', 'apple').run,
                    // Check that change is not visible outside yet
                    pf.waterfall(
                        pg.select('price').from('item').where('title', 'apple').val,
                        function (price, callback) {
                            assert.equal(price, 10);
                            callback()
                        }
                    ),
                    // Return price back to not screw up remaining tests
                    client.update('item', {price: 10}).where('title', 'apple').run
                )(callback)
            }, done)
        })

        it('should rollback on error', function (done) {
            pg.transaction(function (client, callback) {
                pf.serial(
                    client.update('item', {price: 42}).where('title', 'apple').run,
                    function (callback) { callback(new Error('Intended rollback')) }
                )(callback)
            }, function (err) {
                assert.equal(err.message, 'Intended rollback')
                pg.select('price').from('item').where('title', 'apple').val(
                    function (err, price) {
                        assert.equal(price, 10);
                        done();
                    })
            })
        })

        it('should work with promises', function () {
            var idle = pg._pool.idleCount;
            return pg.run(function (client) {
                assert.equal(pg._pool.idleCount, idle - 1);
                return client.raw('select 42 as x').val();
            }).then(function (val) {
                assert.equal(val, 42);
                assert.equal(pg._pool.idleCount, idle);
            })
        })

        it('should transact with promises', function () {
            return pg.transaction(function (client) {
                return client.raw('select 42 as x').val();
            }).then(function (val) {
                assert.equal(val, 42);
            })
        })
    })

    var usingNative = process.env.PGBRICKS_TEST_NATIVE || process.env.NODE_PG_FORCE_NATIVE;
    (usingNative ? describe.skip : describe)('Streaming', function () {
        it('should return EventEmitter', function (done) {
            var query = pg.select('title', 'price').from('item').where({price: 10}).stream();

            query.on('error', done);
            query.on('data', function (row) {
                assert.deepEqual(row, {"title": "apple", "price": 10})
            });
            query.on('end', function () {
                done();
            })
        })

        it('should pipe', function () {
            var query = pg.raw('select title, price from item where price = $1', [10]).stream();
            return slurp(query).then(function (data) {
                assert.deepEqual(data, [{"title": "apple", "price": 10}])
            })
        })

        it('should pipe from client', function (done) {
            pg.run(function (client, callback) {
                var query = client.raw('select title, price from item where price = 10').stream();
                slurp(query).then(function (data) {
                    assert.deepEqual(data, [{"title": "apple", "price": 10}])
                    done();
                }).catch(done);
            }, done)
        })

        it('should error out', function (done) {
            var stream = pg.raw('select no_col from item').stream();
            stream.on('error', function (err) {
                assert.equal(err.message, 'column "no_col" does not exist')
                done()
            })
            stream.on('data', function () {
                throw Error('Unexpected data from broken query')
            })
        })

        it('should error out from client', function (done) {
            pg.run(function (client, callback) {
                var stream = client.raw('select no_col from item').stream();
                stream.on('error', function (err) {
                    assert.equal(err.message, 'column "no_col" does not exist')
                    callback()
                })
                stream.on('data', function () {
                    throw Error('Unexpected data from broken query')
                })
            }, done)
        })
    })
})


// Helper stream
var stream = require('stream')
var util   = require('util');

util.inherits(StoreStream, stream.Writable);
function StoreStream(options) {
    stream.Writable.call(this, options);
    this._store = [];
}

StoreStream.prototype.write = function (chunk, encoding, callback) {
    this._store.push(chunk);
};

function slurp(stream) {
    var store = new StoreStream();
    stream.pipe(store);
    return new Promise(function (resolve, reject) {
        stream.on('error', reject)
        stream.on('end', function () {resolve(store._store)})
    })
}
