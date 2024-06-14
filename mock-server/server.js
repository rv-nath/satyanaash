const jsonServer = require("json-server");
const express = require("express");
const jwt = require("jsonwebtoken");

const server = jsonServer.create();
const router = jsonServer.router("db.json");
const middlewares = jsonServer.defaults();
const PORT = process.env.PORT || 3000;

server.use(express.json());
server.use(middlewares);

// Secret key for JWT
const secretKey = "yourSecretKey";

// Custom login route
server.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  // Perform authentication (you can replace this with your actual authentication logic)
  if (username === "admin" && password === "admin") {
    const token = jwt.sign({ username }, secretKey);
    res.json({ token });
  } else {
    res.status(401).json({ message: "Invalid username or password" });
  }
});

// Middleware to check JWT token
server.use((req, res, next) => {
  if (req.path === "/api/login" || req.method === "OPTIONS") {
    // Skip token verification for login and preflight requests
    next();
  } else {
    const token = req.headers.authorization
      ? req.headers.authorization.split(" ")[1]
      : null;
    if (token) {
      jwt.verify(token, secretKey, (err, decoded) => {
        if (err) {
          res.status(401).json({ message: "Invalid token" });
        } else {
          // Attach decoded token payload to request object
          req.decoded = decoded;
          next();
        }
      });
    } else {
      res.status(401).json({ message: "Token is required" });
    }
  }
});

// Use default router
server.use(router);

server.listen(PORT, () => {
  console.log(`JSON Server is running on port ${PORT}`);
});
