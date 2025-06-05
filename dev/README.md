# Budget App Development Guide

This document provides comprehensive information for developers who want to contribute to or understand the Budget application.

## Project Overview

Budget is a web application for tracking financial accounts and transactions. It helps users understand their money flow and establish long-term financial plans. The application integrates with third-party APIs like [Plaid](https://plaid.com/) and [SimpleFin](https://www.simplefin.org) to fetch financial data.

## Tech Stack

- **Frontend**: React (TypeScript)
- **Backend**: Node.js with Express (TypeScript)
- **Database**: Elasticsearch
- **Containerization**: Docker
- **External APIs**: Plaid, SimpleFin, Polygon

## Project Structure

```
budget/
├── src/                      # Source code
│   ├── client/               # Frontend React application
│   │   ├── components/       # Reusable UI components
│   │   ├── pages/            # Page components
│   │   └── lib/              # Frontend utilities
│   ├── server/               # Backend Express server
│   │   ├── lib/              # Server utilities and integrations
│   │   │   ├── elasticsearch/  # Elasticsearch client and operations
│   │   │   ├── plaid/        # Plaid API integration
│   │   │   ├── simple-fin/   # SimpleFin API integration
│   │   │   └── compute-tools/  # Data processing utilities
│   │   └── routes/           # API endpoints
│   │       ├── accounts/     # Account management endpoints
│   │       ├── budgets/      # Budget management endpoints
│   │       ├── charts/       # Chart data endpoints
│   │       ├── users/        # User management endpoints
│   │       └── webhooks/     # Webhook handlers
│   └── common/               # Shared code between client and server
│       ├── models/           # Data models and types
│       └── utils/            # Shared utilities
├── public/                   # Static assets
├── build/                    # Compiled output
├── test/                     # Test files
└── _manual_tools/            # Development and maintenance tools
```

## Development Setup

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Docker and Docker Compose (optional, for containerized development)
- Elasticsearch instance (local or remote)

### Local Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/hoiekim/budget.git
   cd budget
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` with your configuration:
   - `ADMIN_PASSWORD`: Password for the admin user
   - `ELASTICSEARCH_HOST`: URL to your Elasticsearch instance
   - `PLAID_CLIENT_ID` and `PLAID_SECRET_*`: Credentials for Plaid API (optional)
   - `HOST_NAME`: Domain name for hosting (required for OAuth with Plaid)
   - `POLYGON_API_KEY`: API key for Polygon.io (optional, for investment metadata)

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Start the development server**
   
   For client development:
   ```bash
   npm run dev-client
   ```
   
   For server development:
   ```bash
   npm run dev-server
   ```
   
   For full stack development, run both commands in separate terminals.

### Docker Development Setup

1. **Build and start the containers**
   ```bash
   docker-compose up -d
   ```

2. **Access the application**
   
   The application will be available at http://localhost:3005

## Build Process

The project uses a multi-step build process:

1. **Build the server**
   ```bash
   npm run build-server
   ```
   This compiles TypeScript files and bundles the server code.

2. **Build the client**
   ```bash
   npm run build-client
   ```
   This creates an optimized production build of the React application.

3. **Build everything**
   ```bash
   npm run build
   ```
   This runs both server and client builds.

## Testing

Run tests with:
```bash
npm test
```

The project uses Jest for testing.

## Data Models

The application uses several key data models defined in `src/common/models/`:

- **Account**: Represents a financial account
- **Transaction**: Represents a financial transaction
- **Budget**: Represents a budget plan
- **BudgetFamily**: Groups related budgets
- **Item**: Represents a connection to a financial institution
- **Snapshot**: Point-in-time record of account balances
- **Chart**: Visualization configuration

## API Integration

### Plaid Integration

The application uses Plaid to connect to financial institutions and fetch account and transaction data. The integration is handled in `src/server/lib/plaid/`.

### SimpleFin Integration

SimpleFin provides an alternative method to connect to financial institutions. The integration is handled in `src/server/lib/simple-fin/`.

### Polygon Integration

Polygon.io is used to fetch metadata for investment items when not available from the primary data providers. The integration is in `src/server/lib/polygon.ts`.

## Database (Elasticsearch)

The application uses Elasticsearch to store and query financial data. The Elasticsearch client and operations are defined in `src/server/lib/elasticsearch/`.

## Contributing Guidelines

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes and test thoroughly**

3. **Submit a pull request**
   - Provide a clear description of the changes
   - Reference any related issues

## Deployment

### Production Deployment

1. **Build the application**
   ```bash
   npm run build
   ```

2. **Start the production server**
   ```bash
   npm run start-server
   ```

### Docker Deployment

Use the provided `docker-compose.yml` file to deploy the application with Elasticsearch:

```bash
docker-compose up -d
```

## Troubleshooting

### Common Issues

1. **Elasticsearch connection issues**
   - Verify Elasticsearch is running
   - Check the `ELASTICSEARCH_HOST` environment variable
   - Ensure network connectivity between the app and Elasticsearch

2. **Plaid API errors**
   - Verify Plaid API credentials
   - Check API request logs for specific error messages

3. **Build errors**
   - Clear the build directory: `rm -rf build/`
   - Reinstall dependencies: `npm ci`
   - Try building again: `npm run build`

## Resources

- [Plaid API Documentation](https://plaid.com/docs/)
- [SimpleFin Documentation](https://www.simplefin.org/documentation/)
- [Elasticsearch Documentation](https://www.elastic.co/guide/index.html)
- [React Documentation](https://reactjs.org/docs/getting-started.html)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
