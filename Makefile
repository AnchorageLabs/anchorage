.PHONY: help install build test typecheck check format clean

help:
	@echo "Anchorage Monorepo Tasks:"
	@echo "  make install     install dependencies"
	@echo "  make build       build all packages and agents"
	@echo "  make test        run all tests"
	@echo "  make typecheck   run typescript type checking"
	@echo "  make check       run lint, typecheck, and tests"
	@echo "  make format      format code with biome"
	@echo "  make clean       remove build artifacts"

install:
	corepack pnpm install

build:
	corepack pnpm -r build

test:
	corepack pnpm -r test

typecheck:
	corepack pnpm -r typecheck

check:
	corepack pnpm check

format:
	corepack pnpm format

clean:
	find . -name "dist" -type d -exec rm -rf {} +
	find . -name "node_modules" -type d -exec rm -rf {} +
