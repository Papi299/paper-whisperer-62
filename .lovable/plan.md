

# Scientific Paper Index

A modern, multi-user platform to build and manage collections of scientific papers with automatic metadata fetching from PubMed and Crossref.

---

## Core Features

### 1. User Authentication
- Email/password registration and login
- Each user has their own private paper collections
- Secure session management

### 2. Paper Input & Fetching
- **Smart identifier detection**: Paste PMIDs, DOIs, PubMed links, or paper titles
- **Bulk input support**: Add multiple papers at once by pasting a list of identifiers
- **Automatic data fetching**: Pull metadata from PubMed API first, fallback to Crossref when unavailable
- **Manual editing**: Add or update fields that APIs don't provide (Study Type, Statistical Methods, etc.)

### 3. Paper Data Fields
Each paper entry will include:
- Title
- Author(s)
- Year
- Journal
- PMID
- Study Type (editable)
- Statistical Methods (editable)
- Keywords
- Links: PubMed, Journal, Google Scholar

### 4. Organization System
- **Projects/Collections**: Group papers into research projects (e.g., "Thesis Literature Review", "COVID-19 Studies")
- **Tags**: Add custom tags to papers for flexible categorization

### 5. Search & Filter
- **Full-text search**: Search across titles, authors, journals, and abstracts
- **Keyword filtering**: Filter papers by their keywords (from PubMed/Crossref metadata)
- **Additional filters**: Year range, journal, study type, tags, and collection
- **Combined filtering**: Apply multiple filters simultaneously for precise results

### 6. Export
- Download your paper index as CSV/Excel
- Filter exports by collection, tags, or current search results

---

## Design
- **Modern & Minimal** aesthetic with a clean, professional interface
- Responsive design for desktop and tablet use
- Subtle animations and intuitive navigation

---

## Technical Approach
- **Backend**: Supabase (via Lovable Cloud) for database, authentication, and Edge Functions
- **API Integration**: Edge functions to securely fetch data from PubMed and Crossref APIs
- **Frontend**: React with a polished component library

