# Base image from Microsoft with Playwright and browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json* ./

# Install backend dependencies
RUN npm install

# Copy frontend package files
COPY frontend/package.json frontend/package-lock.json* ./frontend/

# Install frontend dependencies
RUN cd frontend && npm install

# Copy the rest of the application code
COPY . .

# Build the frontend (React)
RUN cd frontend && npm run build

# Expose the backend port
EXPOSE 3001

# Start the Express server
CMD ["npm", "start"]
