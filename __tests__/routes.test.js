'use strict';

const http = require('http');
const express = require('express');
const session = require('express-session');
const superagent = require('superagent');
const fs = require('fs');
const User = require('../models/users');

// Shared state for controlling multer behavior in each test.
// Declared with var so it is accessible when the jest.mock factory runs (after hoisting).
var multerState = { file: null }; // eslint-disable-line no-var

// ─── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../models/users', () => {
  const UserMock = jest.fn();
  UserMock.find = jest.fn();
  UserMock.countDocuments = jest.fn();
  UserMock.findById = jest.fn();
  UserMock.findByIdAndUpdate = jest.fn();
  UserMock.findByIdAndDelete = jest.fn();
  return UserMock;
});

jest.mock('fs');

jest.mock('multer', () => {
  const m = jest.fn(() => ({
    single: jest.fn(() => (req, res, next) => {
      if (multerState && multerState.file) req.file = multerState.file;
      next();
    }),
  }));
  m.diskStorage = jest.fn(() => ({}));
  return m;
});

// Router must be required AFTER mocks so the mocked modules are in place.
const router = require('../routes/routes');

// ─── Test app factory ────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));

  // Intercept res.render before the router so the EJS engine is never invoked.
  // The handler's render data is returned as JSON, which tests can assert on.
  app.use((req, res, next) => {
    res.render = (view, data) => res.json(data || {});
    next();
  });

  // Intercept res.redirect() to copy req.session.message into response headers
  // before the redirect fires, giving tests a way to assert on session state
  // without needing a follow-up request.
  app.use((req, res, next) => {
    const orig = res.redirect.bind(res);
    res.redirect = (location) => {
      if (req.session && req.session.message) {
        res.setHeader('x-session-type', req.session.message.type);
        res.setHeader('x-session-message', req.session.message.message);
      }
      orig(location);
    };
    next();
  });

  app.use('/', router);
  return app;
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

let server, port;

beforeAll((done) => {
  server = http.createServer(createApp());
  server.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => { server.close(done); });

const addr = (path = '') => `http://localhost:${port}${path}`;

// ─── Per-test mock setup ─────────────────────────────────────────────────────

function setupFindChain(users = [], count = 0) {
  const chain = {
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    sort: jest.fn().mockResolvedValue(users),
  };
  User.find.mockReturnValue(chain);
  User.countDocuments.mockResolvedValue(count);
  return chain;
}

let mockSave;

beforeEach(() => {
  jest.resetAllMocks();
  multerState.file = null;

  fs.unlinkSync.mockImplementation(() => {});
  mockSave = jest.fn().mockResolvedValue({});
  User.mockImplementation(() => ({ save: mockSave }));

  setupFindChain();
  User.findById.mockResolvedValue(null);
  User.findByIdAndUpdate.mockResolvedValue(null);
  User.findByIdAndDelete.mockResolvedValue(null);
});

// ─── Static render routes ────────────────────────────────────────────────────

describe('Static render routes', () => {
  test.each(['/contact', '/about', '/add'])('GET %s returns 200', async (path) => {
    const res = await superagent.get(addr(path)).ok(() => true);
    expect(res.status).toBe(200);
  });
});

// ─── POST /add ───────────────────────────────────────────────────────────────

describe('POST /add — Insert user', () => {
  const baseFormData = { name: 'Alice', email: 'alice@test.com', phone: '555-0100' };

  test('success: creates user with uploaded file and redirects to /', async () => {
    multerState.file = { filename: 'photo_123.jpg' };

    const res = await superagent
      .post(addr('/add'))
      .type('form')
      .send(baseFormData)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.headers['x-session-type']).toBe('success');
    expect(User).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alice', email: 'alice@test.com', phone: '555-0100', image: 'photo_123.jpg' })
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  test('success: uses default image when no file is uploaded', async () => {
    const res = await superagent
      .post(addr('/add'))
      .type('form')
      .send(baseFormData)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('success');
    expect(User).toHaveBeenCalledWith(expect.objectContaining({ image: 'user_unknown.png' }));
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  test('error: save() throws a validation error (missing required field)', async () => {
    mockSave.mockRejectedValue(
      new Error("users validation failed: name: Path 'name' is required.")
    );

    const res = await superagent
      .post(addr('/add'))
      .type('form')
      .send({ email: 'x@test.com', phone: '123' }) // name intentionally omitted
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('danger');
    expect(res.headers['x-session-message']).toMatch(/required/i);
  });

  test('error: save() throws a duplicate key error (user already exists)', async () => {
    const err = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    mockSave.mockRejectedValue(err);

    const res = await superagent
      .post(addr('/add'))
      .type('form')
      .send(baseFormData)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('danger');
    expect(res.headers['x-session-message']).toMatch(/duplicate key/i);
  });
});

// ─── GET / ───────────────────────────────────────────────────────────────────

describe('GET / — List users', () => {
  test('success: renders index with default pagination (page 1, limit 10)', async () => {
    const users = [{ name: 'Alice' }];
    setupFindChain(users, 1);

    const res = await superagent.get(addr('/')).ok(() => true);

    expect(res.status).toBe(200);
    expect(res.body.currentPage).toBe(1);
    expect(res.body.totalPages).toBe(1);
    expect(res.body.users).toEqual(users);
  });

  test('success: passes search regex query to User.find when ?search= is provided', async () => {
    setupFindChain([{ name: 'Alice' }], 1);

    await superagent.get(addr('/?search=alice')).ok(() => true);

    expect(User.find).toHaveBeenCalledWith({
      name: { $regex: 'alice', $options: 'i' },
    });
  });

  test('success: applies correct skip and totalPages for page 2 with limit 5', async () => {
    const chain = setupFindChain([], 15);

    const res = await superagent.get(addr('/?page=2&limit=5')).ok(() => true);

    expect(chain.skip).toHaveBeenCalledWith(5);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.currentPage).toBe(2);
  });

  test('success: sorts by specified field in descending order', async () => {
    const chain = setupFindChain();

    await superagent.get(addr('/?sort=email&order=desc')).ok(() => true);

    expect(chain.sort).toHaveBeenCalledWith({ email: -1 });
  });

  test('error: returns JSON error message when User.find throws', async () => {
    User.find.mockImplementation(() => {
      throw new Error('DB connection lost');
    });

    const res = await superagent.get(addr('/')).ok(() => true);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('DB connection lost');
  });
});

// ─── GET /edit/:id ───────────────────────────────────────────────────────────

describe('GET /edit/:id — Edit user form', () => {
  test('success: renders edit_user template when user is found', async () => {
    const user = { _id: 'abc123', name: 'Bob', email: 'bob@test.com', phone: '555-0200', image: 'bob.jpg' };
    User.findById.mockResolvedValue(user);

    const res = await superagent.get(addr('/edit/abc123')).ok(() => true);

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Bob');
    expect(User.findById).toHaveBeenCalledWith('abc123');
  });

  test('not found: redirects to / when user does not exist', async () => {
    User.findById.mockResolvedValue(null);

    const res = await superagent.get(addr('/edit/notexist')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('error: redirects with danger session message when findById throws', async () => {
    User.findById.mockRejectedValue(new Error('Cast to ObjectId failed'));

    const res = await superagent.get(addr('/edit/bad-id')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('danger');
    expect(res.headers['x-session-message']).toBe('Cast to ObjectId failed');
  });
});

// ─── POST /update/:id ────────────────────────────────────────────────────────

describe('POST /update/:id — Update user', () => {
  const baseUpdate = { name: 'Alice Updated', email: 'alice@test.com', phone: '555-0100', old_image: 'old.jpg' };

  test('success: keeps old image when no new file is uploaded', async () => {
    User.findByIdAndUpdate.mockResolvedValue({ ...baseUpdate, _id: 'abc123' });

    const res = await superagent
      .post(addr('/update/abc123'))
      .type('form')
      .send(baseUpdate)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('success');
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ image: 'old.jpg' }),
      { new: true }
    );
  });

  test('success: deletes old image and uses new filename when a file is uploaded', async () => {
    multerState.file = { filename: 'new_photo.jpg' };
    User.findByIdAndUpdate.mockResolvedValue({ ...baseUpdate, image: 'new_photo.jpg' });

    const res = await superagent
      .post(addr('/update/abc123'))
      .type('form')
      .send(baseUpdate)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('success');
    expect(fs.unlinkSync).toHaveBeenCalledWith('./uploads/old.jpg');
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'abc123',
      expect.objectContaining({ image: 'new_photo.jpg' }),
      { new: true }
    );
  });

  test('error: redirects with danger session message when findByIdAndUpdate throws', async () => {
    User.findByIdAndUpdate.mockRejectedValue(new Error('Update failed'));

    const res = await superagent
      .post(addr('/update/abc123'))
      .type('form')
      .send(baseUpdate)
      .redirects(0)
      .ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('danger');
    expect(res.headers['x-session-message']).toBe('Update failed');
  });
});

// ─── GET /delete/:id ─────────────────────────────────────────────────────────

describe('GET /delete/:id — Delete user', () => {
  test('success: deletes user and removes associated image file', async () => {
    User.findByIdAndDelete.mockResolvedValue({ _id: 'abc123', image: 'photo.png' });

    const res = await superagent.get(addr('/delete/abc123')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('info');
    expect(fs.unlinkSync).toHaveBeenCalledWith('./uploads/photo.png');
  });

  test('resilient: still sets info message when image file deletion fails', async () => {
    User.findByIdAndDelete.mockResolvedValue({ _id: 'abc123', image: 'photo.png' });
    fs.unlinkSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const res = await superagent.get(addr('/delete/abc123')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('info');
  });

  test('success: does not call unlinkSync when deleted user has no image', async () => {
    User.findByIdAndDelete.mockResolvedValue({ _id: 'abc123', image: null });

    const res = await superagent.get(addr('/delete/abc123')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('info');
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  test('error: redirects with danger session message when findByIdAndDelete throws', async () => {
    User.findByIdAndDelete.mockRejectedValue(new Error('Delete failed'));

    const res = await superagent.get(addr('/delete/abc123')).redirects(0).ok(() => true);

    expect(res.status).toBe(302);
    expect(res.headers['x-session-type']).toBe('danger');
    expect(res.headers['x-session-message']).toBe('Delete failed');
  });
});
