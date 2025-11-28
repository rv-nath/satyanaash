const jsonServer = require("json-server");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");

const server = jsonServer.create();
const router = jsonServer.router("db.json");
const middlewares = jsonServer.defaults();
const PORT = process.env.PORT || 3000;

server.use(express.json());
server.use(middlewares);


// Setup storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
  

// Initialize multer with diskStorage
const upload = multer({ storage });

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

// upl  oads route to handle file uploads
server.post("/api/upload", upload.single("file"), (req, res) => {
  if (req.file) {
    res.json({ url: `/uploads/${req.file.filename}` });
  } else {
    res.status(400).json({ message: "File upload error" });
  }
})

// Modified configuration to accept multiple files under the same field name
server.post('/api/uploads', upload.array('file', 10), (req, res) => {
  // Handle the uploaded files in req.files
  res.status(200).json({ message: 'Files uploaded successfully' });
});

// Uploads route to handle file uploads along with additional form fields
server.post("/api/upload_with_params", upload.single("file"), (req, res) => {
  if (req.file) {
    // Extract additional form fields from req.body
    const { var1, var2 } = req.body;

    // Respond with the file URL and the additional data
    res.json({
      url: `/uploads/${req.file.filename}`,
      var1: var1 || null,
      var2: var2 || null,
    });
  } else {
    res.status(400).json({ message: "File upload error" });
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
