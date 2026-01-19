FROM --platform=linux/amd64 node:20-bullseye

# Install FUSE, build tools, sudo, kmod, and nano
RUN apt-get update && \
    apt-get install -y fuse libfuse-dev build-essential python3 sudo kmod nano && \
    rm -rf /var/lib/apt/lists/*

# Configure FUSE to allow non-root users
RUN echo "user_allow_other" >> /etc/fuse.conf && \
    chmod 644 /etc/fuse.conf

# Create /dev/fuse device node
RUN mknod /dev/fuse c 10 229 || true && \
    chmod 666 /dev/fuse

# Create non-root user for FUSE
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies (fresh build for Linux arch)
RUN npm install

# Copy source (exclude node_modules via .dockerignore)
COPY . .

# Build TypeScript
RUN npm run build

# Fix permissions for testuser
RUN chown -R testuser:testuser /app

# Switch to non-root user
USER testuser

# Create mount directory
RUN mkdir -p /home/testuser/graph-mount

CMD ["/bin/bash"]
