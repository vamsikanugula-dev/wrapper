/**
 * Clerk authentication for the Express API.
 *
 * For development/testing, we use mock authentication to avoid needing actual Clerk credentials.
 * In production, you would use the real Clerk middleware.
 *
 * To use real Clerk authentication, uncomment the Clerk code below and comment out the mock.
 */

// Mock authentication for development/testing
const requireAuth = (req, res, next) => {
  // Mock authentication for development/testing
  if (!req.auth) {
    req.auth = {
      userId: 'test_user_123',
      sessionId: 'test_session',
      // Add other auth properties as needed
    };
  }
  next();
};

// Optional: Middleware to get user info
const getUser = (req, res, next) => {
  if (req.auth && req.auth.userId) {
    req.user = {
      userId: req.auth.userId,
      // Add other user info as needed from JWT or session
    };
  }
  next();
};

/*
// Real Clerk authentication (uncomment for production)
const { clerkMiddleware, getAuth, clerkClient } = require('@clerk/express');

// Reads the Authorization: Bearer <session token> header (or Clerk cookies) and verifies it.
const attachClerk = clerkMiddleware();

const rejectIfSignedOut = (req, res, next) => {
  const auth = getAuth(req);
  if (!auth || !auth.userId) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  // Plain object so the rest of the app can keep using req.auth.userId
  req.auth = { userId: auth.userId, sessionId: auth.sessionId };
  next();
};

const requireAuth = [attachClerk, rejectIfSignedOut];

// Optional: loads the full Clerk user (name, email) onto req.user. Use after requireAuth.
const getUser = async (req, res, next) => {
  try {
    req.user = await clerkClient.users.getUser(req.auth.userId);
    next();
  } catch (e) {
    next(e);
  }
};
*/

module.exports = {
  requireAuth,
  getUser
};