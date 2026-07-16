#!/usr/bin/env node
import { buildProgram } from './index'

buildProgram(process.cwd(), process.env).parse()
