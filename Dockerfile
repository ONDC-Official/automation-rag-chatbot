# Use the official uv base image
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Set the working directory
WORKDIR /app

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy project configuration files
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --frozen --no-install-project --no-dev

# Copy the application code
COPY . .

# Expose the chatbot server port
EXPOSE 8000

# Run the chatbot server
CMD ["uv", "run", "python", "main.py"]
